// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.
import * as path from 'path';
import {
    CancellationToken,
    CodeAction,
    CodeLens,
    Command,
    CompletionItem,
    Declaration as VDeclaration,
    Definition,
    DefinitionLink,
    Diagnostic,
    DocumentHighlight,
    DocumentLink,
    DocumentSymbol,
    Location,
    ProviderResult,
    Range,
    SymbolInformation,
    TextEdit,
    Uri,
    WorkspaceEdit
} from 'vscode';
import {
    ConfigurationParams,
    ConfigurationRequest,
    HandleDiagnosticsSignature,
    HandlerResult,
    Middleware,
    ResponseError
} from 'vscode-languageclient/node';
import { IJupyterExtensionDependencyManager, IVSCodeNotebook } from '../common/application/types';

import { HiddenFilePrefix, PYTHON_LANGUAGE } from '../common/constants';
import { CollectLSRequestTiming, CollectNodeLSRequestTiming } from '../common/experiments/groups';
import { IConfigurationService, IDisposableRegistry, IExperimentsManager, IExtensions } from '../common/types';
import { isThenable } from '../common/utils/async';
import { StopWatch } from '../common/utils/stopWatch';
import { NotebookMiddlewareAddon } from '../datascience/languageserver/notebookMiddlewareAddon';
import { IServiceContainer } from '../ioc/types';
import { sendTelemetryEvent } from '../telemetry';
import { EventName } from '../telemetry/constants';
import { LanguageServerType } from './types';

// Only send 100 events per hour.
const globalDebounce = 1000 * 60 * 60;
const globalLimit = 100;

// For calls that are more likely to happen during a session (hover, completion, document symbols).
const debounceFrequentCall = 1000 * 60 * 5;

// For calls that are less likely to happen during a session (go-to-def, workspace symbols).
const debounceRareCall = 1000 * 60;

export class LanguageClientMiddleware implements Middleware {
    // These are public so that the captureTelemetryForLSPMethod decorator can access them.
    public readonly eventName: EventName | undefined;
    public readonly lastCaptured = new Map<string, number>();
    public nextWindow: number = 0;
    public eventCount: number = 0;

    public workspace = {
        // tslint:disable:no-any
        configuration: (
            params: ConfigurationParams,
            token: CancellationToken,
            next: ConfigurationRequest.HandlerSignature
        ): HandlerResult<any[], void> => {
            const configService = this.serviceContainer.get<IConfigurationService>(IConfigurationService);

            // Hand-collapse "Thenable<A> | Thenable<B> | Thenable<A|B>" into just "Thenable<A|B>" to make TS happy.
            const result: any[] | ResponseError<void> | Thenable<any[] | ResponseError<void>> = next(params, token);

            // For backwards compatibility, set python.pythonPath to the configured
            // value as though it were in the user's settings.json file.
            const addPythonPath = (settings: any[] | ResponseError<void>) => {
                if (settings instanceof ResponseError) {
                    return settings;
                }

                params.items.forEach((item, i) => {
                    if (item.section === 'python') {
                        const uri = item.scopeUri ? Uri.parse(item.scopeUri) : undefined;
                        settings[i].pythonPath = configService.getSettings(uri).pythonPath;
                    }
                });

                return settings;
            };

            if (isThenable(result)) {
                return result.then(addPythonPath);
            }

            return addPythonPath(result);
        }
        // tslint:enable:no-any
    };
    private notebookAddon: NotebookMiddlewareAddon | undefined;

    private connected = false; // Default to not forwarding to VS code.

    public constructor(
        readonly serviceContainer: IServiceContainer,
        serverType: LanguageServerType,
        public readonly serverVersion?: string
    ) {
        this.handleDiagnostics = this.handleDiagnostics.bind(this); // VS Code calls function without context.
        this.didOpen = this.didOpen.bind(this);
        this.didSave = this.didSave.bind(this);
        this.didChange = this.didChange.bind(this);
        this.didClose = this.didClose.bind(this);
        this.willSave = this.willSave.bind(this);
        this.willSaveWaitUntil = this.willSaveWaitUntil.bind(this);

        let group: { experiment: string; control: string } | undefined;

        if (serverType === LanguageServerType.Microsoft) {
            this.eventName = EventName.PYTHON_LANGUAGE_SERVER_REQUEST;
            group = CollectLSRequestTiming;
        } else if (serverType === LanguageServerType.Node) {
            this.eventName = EventName.LANGUAGE_SERVER_REQUEST;
            group = CollectNodeLSRequestTiming;
        } else {
            return;
        }

        const experimentsManager = this.serviceContainer.get<IExperimentsManager>(IExperimentsManager);
        const jupyterDependencyManager = this.serviceContainer.get<IJupyterExtensionDependencyManager>(
            IJupyterExtensionDependencyManager
        );
        const notebookApi = this.serviceContainer.get<IVSCodeNotebook>(IVSCodeNotebook);
        const disposables = this.serviceContainer.get<IDisposableRegistry>(IDisposableRegistry);
        const extensions = this.serviceContainer.get<IExtensions>(IExtensions);

        if (!experimentsManager.inExperiment(group.experiment)) {
            this.eventName = undefined;
            experimentsManager.sendTelemetryIfInExperiment(group.control);
        }
        // Enable notebook support if jupyter support is installed
        if (jupyterDependencyManager.isJupyterExtensionInstalled) {
            this.notebookAddon = new NotebookMiddlewareAddon(notebookApi, PYTHON_LANGUAGE, /.*\.ipynb/m);
        }
        disposables.push(
            extensions.onDidChange(() => {
                if (this.notebookAddon && !jupyterDependencyManager.isJupyterExtensionInstalled) {
                    this.notebookAddon = undefined;
                } else if (!this.notebookAddon && jupyterDependencyManager.isJupyterExtensionInstalled) {
                    this.notebookAddon = new NotebookMiddlewareAddon(notebookApi, PYTHON_LANGUAGE, /.*\.ipynb/m);
                }
            })
        );
    }

    public connect() {
        this.connected = true;
    }

    public disconnect() {
        this.connected = false;
    }

    public didChange() {
        if (this.connected) {
            return this.callNext('didChange', arguments);
        }
    }

    public didOpen() {
        // Special case, open and close happen before we connect.
        return this.callNext('didOpen', arguments);
    }

    public didClose() {
        // Special case, open and close happen before we connect.
        return this.callNext('didClose', arguments);
    }

    public didSave() {
        if (this.connected) {
            return this.callNext('didSave', arguments);
        }
    }

    public willSave() {
        if (this.connected) {
            return this.callNext('willSave', arguments);
        }
    }

    public willSaveWaitUntil() {
        if (this.connected) {
            return this.callNext('willSaveWaitUntil', arguments);
        }
    }

    @captureTelemetryForLSPMethod('textDocument/completion', debounceFrequentCall)
    public provideCompletionItem() {
        if (this.connected) {
            return this.callNext('provideCompletionItem', arguments);
        }
    }

    @captureTelemetryForLSPMethod('textDocument/hover', debounceFrequentCall)
    public provideHover() {
        if (this.connected) {
            return this.callNext('provideHover', arguments);
        }
    }

    public handleDiagnostics(uri: Uri, _diagnostics: Diagnostic[], _next: HandleDiagnosticsSignature) {
        if (this.connected) {
            // Skip sending if this is a special file.
            const filePath = uri.fsPath;
            const baseName = filePath ? path.basename(filePath) : undefined;
            if (!baseName || !baseName.startsWith(HiddenFilePrefix)) {
                return this.callNext('handleDiagnostics', arguments);
            }
        }
    }

    @captureTelemetryForLSPMethod('completionItem/resolve', debounceFrequentCall)
    public resolveCompletionItem(): ProviderResult<CompletionItem> {
        if (this.connected) {
            return this.callNext('resolveCompletionItem', arguments);
        }
    }

    @captureTelemetryForLSPMethod('textDocument/signatureHelp', debounceFrequentCall)
    public provideSignatureHelp() {
        if (this.connected) {
            return this.callNext('provideSignatureHelp', arguments);
        }
    }

    @captureTelemetryForLSPMethod('textDocument/definition', debounceRareCall)
    public provideDefinition(): ProviderResult<Definition | DefinitionLink[]> {
        if (this.connected) {
            return this.callNext('provideDefinition', arguments);
        }
    }

    @captureTelemetryForLSPMethod('textDocument/references', debounceRareCall)
    public provideReferences(): ProviderResult<Location[]> {
        if (this.connected) {
            return this.callNext('provideReferences', arguments);
        }
    }

    public provideDocumentHighlights(): ProviderResult<DocumentHighlight[]> {
        if (this.connected) {
            return this.callNext('provideDocumentHighlights', arguments);
        }
    }

    @captureTelemetryForLSPMethod('textDocument/documentSymbol', debounceFrequentCall)
    public provideDocumentSymbols(): ProviderResult<SymbolInformation[] | DocumentSymbol[]> {
        if (this.connected) {
            return this.callNext('provideDocumentSymbols', arguments);
        }
    }

    @captureTelemetryForLSPMethod('workspace/symbol', debounceRareCall)
    public provideWorkspaceSymbols(): ProviderResult<SymbolInformation[]> {
        if (this.connected) {
            return this.callNext('provideWorkspaceSymbols', arguments);
        }
    }

    @captureTelemetryForLSPMethod('textDocument/codeAction', debounceFrequentCall)
    public provideCodeActions(): ProviderResult<(Command | CodeAction)[]> {
        if (this.connected) {
            return this.callNext('provideCodeActions', arguments);
        }
    }

    @captureTelemetryForLSPMethod('textDocument/codeLens', debounceFrequentCall)
    public provideCodeLenses(): ProviderResult<CodeLens[]> {
        if (this.connected) {
            return this.callNext('provideCodeLenses', arguments);
        }
    }

    @captureTelemetryForLSPMethod('codeLens/resolve', debounceFrequentCall)
    public resolveCodeLens(): ProviderResult<CodeLens> {
        if (this.connected) {
            return this.callNext('resolveCodeLens', arguments);
        }
    }

    public provideDocumentFormattingEdits(): ProviderResult<TextEdit[]> {
        if (this.connected) {
            return this.callNext('provideDocumentFormattingEdits', arguments);
        }
    }

    public provideDocumentRangeFormattingEdits(): ProviderResult<TextEdit[]> {
        if (this.connected) {
            return this.callNext('provideDocumentRangeFormattingEdits', arguments);
        }
    }

    public provideOnTypeFormattingEdits(): ProviderResult<TextEdit[]> {
        if (this.connected) {
            return this.callNext('provideOnTypeFormattingEdits', arguments);
        }
    }

    @captureTelemetryForLSPMethod('textDocument/rename', debounceRareCall)
    public provideRenameEdits(): ProviderResult<WorkspaceEdit> {
        if (this.connected) {
            return this.callNext('provideRenameEdits', arguments);
        }
    }

    @captureTelemetryForLSPMethod('textDocument/prepareRename', debounceRareCall)
    public prepareRename(): ProviderResult<
        | Range
        | {
              range: Range;
              placeholder: string;
          }
    > {
        if (this.connected) {
            return this.callNext('prepareRename', arguments);
        }
    }

    public provideDocumentLinks(): ProviderResult<DocumentLink[]> {
        if (this.connected) {
            return this.callNext('provideDocumentLinks', arguments);
        }
    }

    public resolveDocumentLink(): ProviderResult<DocumentLink> {
        if (this.connected) {
            return this.callNext('resolveDocumentLink', arguments);
        }
    }

    @captureTelemetryForLSPMethod('textDocument/declaration', debounceRareCall)
    public provideDeclaration(): ProviderResult<VDeclaration> {
        if (this.connected) {
            return this.callNext('provideDeclaration', arguments);
        }
    }

    private callNext(funcName: keyof NotebookMiddlewareAddon, args: IArguments) {
        // This function uses the last argument to call the 'next' item. If we're allowing notebook
        // middleware, it calls into the notebook middleware first.
        if (this.notebookAddon) {
            // It would be nice to use args.callee, but not supported in strict mode
            // tslint:disable-next-line: no-any
            return (this.notebookAddon as any)[funcName](...args);
        } else {
            return args[args.length - 1](...args);
        }
    }
}

function captureTelemetryForLSPMethod(method: string, debounceMilliseconds: number) {
    // tslint:disable-next-line:no-function-expression no-any
    return function (_target: Object, _propertyKey: string, descriptor: TypedPropertyDescriptor<any>) {
        const originalMethod = descriptor.value;

        // tslint:disable-next-line:no-any
        descriptor.value = function (this: LanguageClientMiddleware, ...args: any[]) {
            const eventName = this.eventName;
            if (!eventName) {
                return originalMethod.apply(this, args);
            }

            const now = Date.now();

            if (now > this.nextWindow) {
                // Past the end of the last window, reset.
                this.nextWindow = now + globalDebounce;
                this.eventCount = 0;
            } else if (this.eventCount >= globalLimit) {
                // Sent too many events in this window, don't send.
                return originalMethod.apply(this, args);
            }

            const lastCapture = this.lastCaptured.get(method);
            if (lastCapture && now - lastCapture < debounceMilliseconds) {
                return originalMethod.apply(this, args);
            }

            this.lastCaptured.set(method, now);
            this.eventCount += 1;

            // Replace all slashes in the method name so it doesn't get scrubbed by vscode-extension-telemetry.
            const formattedMethod = method.replace(/\//g, '.');

            const properties = {
                lsVersion: this.serverVersion || 'unknown',
                method: formattedMethod
            };

            const stopWatch = new StopWatch();
            // tslint:disable-next-line:no-unsafe-any
            const result = originalMethod.apply(this, args);

            // tslint:disable-next-line:no-unsafe-any
            if (result && isThenable<void>(result)) {
                result.then(() => {
                    sendTelemetryEvent(eventName, stopWatch.elapsedTime, properties);
                });
            } else {
                sendTelemetryEvent(eventName, stopWatch.elapsedTime, properties);
            }

            return result;
        };

        return descriptor;
    };
}
