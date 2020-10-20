// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.
import {
    CancellationToken,
    CodeAction,
    CodeActionContext,
    CodeLens,
    Command,
    CompletionContext,
    CompletionItem,
    Declaration as VDeclaration,
    Definition,
    DefinitionLink,
    Diagnostic,
    Disposable,
    DocumentHighlight,
    DocumentLink,
    DocumentSelector,
    DocumentSymbol,
    FormattingOptions,
    Location,
    Position,
    Position as VPosition,
    ProviderResult,
    Range,
    SignatureHelp,
    SignatureHelpContext,
    SymbolInformation,
    TextDocument,
    TextDocumentChangeEvent,
    TextDocumentWillSaveEvent,
    TextEdit,
    Uri,
    WorkspaceEdit
} from 'vscode';
import {
    HandleDiagnosticsSignature,
    Middleware,
    PrepareRenameSignature,
    ProvideCodeActionsSignature,
    ProvideCodeLensesSignature,
    ProvideCompletionItemsSignature,
    ProvideDefinitionSignature,
    ProvideDocumentFormattingEditsSignature,
    ProvideDocumentHighlightsSignature,
    ProvideDocumentLinksSignature,
    ProvideDocumentRangeFormattingEditsSignature,
    ProvideDocumentSymbolsSignature,
    ProvideHoverSignature,
    ProvideOnTypeFormattingEditsSignature,
    ProvideReferencesSignature,
    ProvideRenameEditsSignature,
    ProvideSignatureHelpSignature,
    ProvideWorkspaceSymbolsSignature,
    ResolveCodeLensSignature,
    ResolveCompletionItemSignature,
    ResolveDocumentLinkSignature
} from 'vscode-languageclient/node';

import { ProvideDeclarationSignature } from 'vscode-languageclient/lib/common/declaration';
import { IVSCodeNotebook } from '../../common/application/types';
import { isThenable } from '../../common/utils/async';
import { isNotebookCell } from '../../common/utils/misc';
import { NotebookConverter } from './notebookConverter';

/**
 * This class is a temporary solution to handling intellisense and diagnostics in python based notebooks.
 *
 * It is responsible for generating a concatenated document of all of the cells in a notebook and using that as the
 * document for LSP requests.
 */
export class NotebookMiddlewareAddon implements Middleware, Disposable {
    private converter: NotebookConverter;

    constructor(notebookApi: IVSCodeNotebook, cellSelector: DocumentSelector, notebookFileRegex: RegExp) {
        this.converter = new NotebookConverter(notebookApi, cellSelector, notebookFileRegex);
    }

    public dispose() {
        this.converter.dispose();
    }

    public didChange(event: TextDocumentChangeEvent, next: (ev: TextDocumentChangeEvent) => void) {
        // If this is a notebook cell, change this into a concat document event
        if (isNotebookCell(event.document.uri)) {
            const newEvent = this.converter.toOutgoingChangeEvent(event);
            return next(newEvent);
        } else {
            next(event);
        }
    }

    public didOpen(document: TextDocument, next: (ev: TextDocument) => void) {
        // If this is a notebook cell, change this into a concat document if this is the first time.
        if (isNotebookCell(document.uri)) {
            if (!this.converter.hasFiredOpen(document)) {
                this.converter.firedOpen(document);
                const newDoc = this.converter.toOutgoingDocument(document);
                return next(newDoc);
            }
        } else {
            next(document);
        }
    }

    public didClose(document: TextDocument, next: (ev: TextDocument) => void) {
        // If this is a notebook cell, change this into a concat document if this is the first time.
        if (isNotebookCell(document.uri)) {
            // Cell delete causes this callback, but won't fire the close event because it's not
            // in the document anymore.
            if (this.converter.hasCell(document) && !this.converter.hasFiredClose(document)) {
                this.converter.firedClose(document);
                const newDoc = this.converter.toOutgoingDocument(document);
                return next(newDoc);
            }
        } else {
            next(document);
        }
    }

    public didSave(event: TextDocument, next: (ev: TextDocument) => void) {
        return next(event);
    }

    public willSave(event: TextDocumentWillSaveEvent, next: (ev: TextDocumentWillSaveEvent) => void) {
        return next(event);
    }

    public willSaveWaitUntil(
        event: TextDocumentWillSaveEvent,
        next: (ev: TextDocumentWillSaveEvent) => Thenable<TextEdit[]>
    ) {
        return next(event);
    }

    public provideCompletionItem(
        document: TextDocument,
        position: Position,
        context: CompletionContext,
        token: CancellationToken,
        next: ProvideCompletionItemsSignature
    ) {
        if (isNotebookCell(document.uri)) {
            const newDoc = this.converter.toOutgoingDocument(document);
            const newPos = this.converter.toOutgoingPosition(document, position);
            const result = next(newDoc, newPos, context, token);
            if (isThenable(result)) {
                return result.then(this.converter.toIncomingCompletions.bind(this.converter, document));
            }
            return this.converter.toIncomingCompletions(document, result);
        }
        return next(document, position, context, token);
    }

    public provideHover(
        document: TextDocument,
        position: Position,
        token: CancellationToken,
        next: ProvideHoverSignature
    ) {
        if (isNotebookCell(document.uri)) {
            const newDoc = this.converter.toOutgoingDocument(document);
            const newPos = this.converter.toOutgoingPosition(document, position);
            const result = next(newDoc, newPos, token);
            if (isThenable(result)) {
                return result.then(this.converter.toIncomingHover.bind(this.converter, document));
            }
            return this.converter.toIncomingHover(document, result);
        }
        return next(document, position, token);
    }

    public resolveCompletionItem(
        item: CompletionItem,
        token: CancellationToken,
        next: ResolveCompletionItemSignature
    ): ProviderResult<CompletionItem> {
        // Range should have already been remapped.
        // tslint:disable-next-line: no-suspicious-comment
        // TODO: What if the LS needs to read the range? It won't make sense. This might mean
        // doing this at the extension level is not possible.
        return next(item, token);
    }

    public provideSignatureHelp(
        document: TextDocument,
        position: Position,
        context: SignatureHelpContext,
        token: CancellationToken,
        next: ProvideSignatureHelpSignature
    ): ProviderResult<SignatureHelp> {
        if (isNotebookCell(document.uri)) {
            const newDoc = this.converter.toOutgoingDocument(document);
            const newPos = this.converter.toOutgoingPosition(document, position);
            return next(newDoc, newPos, context, token);
        }
        return next(document, position, context, token);
    }

    public provideDefinition(
        document: TextDocument,
        position: Position,
        token: CancellationToken,
        next: ProvideDefinitionSignature
    ): ProviderResult<Definition | DefinitionLink[]> {
        if (isNotebookCell(document.uri)) {
            const newDoc = this.converter.toOutgoingDocument(document);
            const newPos = this.converter.toOutgoingPosition(document, position);
            const result = next(newDoc, newPos, token);
            if (isThenable(result)) {
                return result.then(this.converter.toIncomingLocations.bind(this.converter, document));
            }
            return this.converter.toIncomingLocations(document, result);
        }
        return next(document, position, token);
    }

    public provideReferences(
        document: TextDocument,
        position: Position,
        options: {
            includeDeclaration: boolean;
        },
        token: CancellationToken,
        next: ProvideReferencesSignature
    ): ProviderResult<Location[]> {
        if (isNotebookCell(document.uri)) {
            const newDoc = this.converter.toOutgoingDocument(document);
            const newPos = this.converter.toOutgoingPosition(document, position);
            const result = next(newDoc, newPos, options, token);
            if (isThenable(result)) {
                return result.then(this.converter.toIncomingLocations.bind(this.converter, document));
            }
            return this.converter.toIncomingLocations(document, result);
        }
        return next(document, position, options, token);
    }

    public provideDocumentHighlights(
        document: TextDocument,
        position: Position,
        token: CancellationToken,
        next: ProvideDocumentHighlightsSignature
    ): ProviderResult<DocumentHighlight[]> {
        if (isNotebookCell(document.uri)) {
            const newDoc = this.converter.toOutgoingDocument(document);
            const newPos = this.converter.toOutgoingPosition(document, position);
            const result = next(newDoc, newPos, token);
            if (isThenable(result)) {
                return result.then(this.converter.toIncomingHighlight.bind(this.converter, document));
            }
            return this.converter.toIncomingHighlight(document, result);
        }
        return next(document, position, token);
    }

    public provideDocumentSymbols(
        document: TextDocument,
        token: CancellationToken,
        next: ProvideDocumentSymbolsSignature
    ): ProviderResult<SymbolInformation[] | DocumentSymbol[]> {
        if (isNotebookCell(document.uri)) {
            const newDoc = this.converter.toOutgoingDocument(document);
            const result = next(newDoc, token);
            if (isThenable(result)) {
                return result.then(this.converter.toIncomingSymbols.bind(this.converter, document));
            }
            return this.converter.toIncomingSymbols(document, result);
        }
        return next(document, token);
    }

    public provideWorkspaceSymbols(
        query: string,
        token: CancellationToken,
        next: ProvideWorkspaceSymbolsSignature
    ): ProviderResult<SymbolInformation[]> {
        const result = next(query, token);
        if (isThenable(result)) {
            return result.then(this.converter.toIncomingWorkspaceSymbols.bind(this));
        }
        return this.converter.toIncomingWorkspaceSymbols(result);
    }

    public provideCodeActions(
        _document: TextDocument,
        _range: Range,
        _context: CodeActionContext,
        _token: CancellationToken,
        _next: ProvideCodeActionsSignature
    ): ProviderResult<(Command | CodeAction)[]> {
        // if (isNotebookCell(document.uri)) {
        //     const newDoc = this.converter.toOutgoingDocument(document);
        //     const newRange = this.converter.toOutgoingRange(document, range);
        //     const newContext = this.converter.toOutgoingContext(document, context);
        //     const result = next(newDoc, newRange, newContext, token);
        //     if (isThenable(result)) {
        //         return result.then(this.converter.toIncomingActions.bind(this.converter, document));
        //     }
        //     return this.converter.toIncomingActions(document, result);
        // }
        // return next(document, range, context, token);
        return undefined;
    }

    public provideCodeLenses(
        _document: TextDocument,
        _token: CancellationToken,
        _next: ProvideCodeLensesSignature
    ): ProviderResult<CodeLens[]> {
        // if (isNotebookCell(document.uri)) {
        //     const newDoc = this.converter.toOutgoingDocument(document);
        //     const result = next(newDoc, token);
        //     if (isThenable(result)) {
        //         return result.then(this.converter.toIncomingCodeLenses.bind(this.converter, document));
        //     }
        //     return this.converter.toIncomingCodeLenses(document, result);
        // }
        // return next(document, token);
        return undefined;
    }

    public resolveCodeLens(
        codeLens: CodeLens,
        token: CancellationToken,
        next: ResolveCodeLensSignature
    ): ProviderResult<CodeLens> {
        // Range should have already been remapped.
        // tslint:disable-next-line: no-suspicious-comment
        // TODO: What if the LS needs to read the range? It won't make sense. This might mean
        // doing this at the extension level is not possible.
        return next(codeLens, token);
    }

    public provideDocumentFormattingEdits(
        _document: TextDocument,
        _options: FormattingOptions,
        _token: CancellationToken,
        _next: ProvideDocumentFormattingEditsSignature
    ): ProviderResult<TextEdit[]> {
        // if (isNotebookCell(document.uri)) {
        //     const newDoc = this.converter.toOutgoingDocument(document);
        //     const result = next(newDoc, options, token);
        //     if (isThenable(result)) {
        //         return result.then(this.converter.toIncomingEdits.bind(this.converter, document));
        //     }
        //     return this.converter.toIncomingEdits(document, result);
        // }
        // return next(document, options, token);
        return undefined;
    }

    public provideDocumentRangeFormattingEdits(
        _document: TextDocument,
        _range: Range,
        _options: FormattingOptions,
        _token: CancellationToken,
        _next: ProvideDocumentRangeFormattingEditsSignature
    ): ProviderResult<TextEdit[]> {
        // if (isNotebookCell(document.uri)) {
        //     const newDoc = this.converter.toOutgoingDocument(document);
        //     const newRange = this.converter.toOutgoingRange(document, range);
        //     const result = next(newDoc, newRange, options, token);
        //     if (isThenable(result)) {
        //         return result.then(this.converter.toIncomingEdits.bind(this.converter, document));
        //     }
        //     return this.converter.toIncomingEdits(document, result);
        // }
        // return next(document, range, options, token);
        return undefined;
    }

    public provideOnTypeFormattingEdits(
        _document: TextDocument,
        _position: Position,
        _ch: string,
        _options: FormattingOptions,
        _token: CancellationToken,
        _next: ProvideOnTypeFormattingEditsSignature
    ): ProviderResult<TextEdit[]> {
        // if (isNotebookCell(document.uri)) {
        //     const newDoc = this.converter.toOutgoingDocument(document);
        //     const newPos = this.converter.toOutgoingPosition(document, position);
        //     const result = next(newDoc, newPos, ch, options, token);
        //     if (isThenable(result)) {
        //         return result.then(this.converter.toIncomingEdits.bind(this.converter, document));
        //     }
        //     return this.converter.toIncomingEdits(document, result);
        // }
        // return next(document, position, ch, options, token);
        return undefined;
    }

    public provideRenameEdits(
        _document: TextDocument,
        _position: Position,
        _newName: string,
        _token: CancellationToken,
        _next: ProvideRenameEditsSignature
    ): ProviderResult<WorkspaceEdit> {
        // if (isNotebookCell(document.uri)) {
        //     const newDoc = this.converter.toOutgoingDocument(document);
        //     const newPos = this.converter.toOutgoingPosition(document, position);
        //     const result = next(newDoc, newPos, newName, token);
        //     if (isThenable(result)) {
        //         return result.then(this.converter.toIncomingWorkspaceEdit.bind(this.converter));
        //     }
        //     return this.converter.toIncomingWorkspaceEdit(result);
        // }
        // return next(document, position, newName, token);
        return undefined;
    }

    public prepareRename(
        _document: TextDocument,
        _position: Position,
        _token: CancellationToken,
        _next: PrepareRenameSignature
    ): ProviderResult<
        | Range
        | {
              range: Range;
              placeholder: string;
          }
    > {
        // if (isNotebookCell(document.uri)) {
        //     const newDoc = this.converter.toOutgoingDocument(document);
        //     const newPos = this.converter.toOutgoingPosition(document, position);
        //     const result = next(newDoc, newPos, token);
        //     if (isThenable(result)) {
        //         return result.then(this.converter.toIncomingRename.bind(this.converter, document));
        //     }
        //     return this.converter.toIncomingRename(document, result);
        // }
        // return next(document, position, token);
        return undefined;
    }

    public provideDocumentLinks(
        _document: TextDocument,
        _token: CancellationToken,
        _next: ProvideDocumentLinksSignature
    ): ProviderResult<DocumentLink[]> {
        // if (isNotebookCell(document.uri)) {
        //     const newDoc = this.converter.toOutgoingDocument(document);
        //     const result = next(newDoc, token);
        //     if (isThenable(result)) {
        //         return result.then(this.converter.toIncomingDocumentLinks.bind(this.converter, document));
        //     }
        //     return this.converter.toIncomingDocumentLinks(document, result);
        // }
        // return next(document, token);
        return [];
    }

    public resolveDocumentLink(
        link: DocumentLink,
        token: CancellationToken,
        next: ResolveDocumentLinkSignature
    ): ProviderResult<DocumentLink> {
        // Range should have already been remapped.
        // tslint:disable-next-line: no-suspicious-comment
        // TODO: What if the LS needs to read the range? It won't make sense. This might mean
        // doing this at the extension level is not possible.
        return next(link, token);
    }

    public provideDeclaration(
        _document: TextDocument,
        _position: VPosition,
        _token: CancellationToken,
        _next: ProvideDeclarationSignature
    ): ProviderResult<VDeclaration> {
        // if (isNotebookCell(document.uri)) {
        //     const newDoc = this.converter.toOutgoingDocument(document);
        //     const newPos = this.converter.toOutgoingPosition(document, position);
        //     const result = next(newDoc, newPos, token);
        //     if (isThenable(result)) {
        //         return result.then(this.converter.toIncomingLocations.bind(this.converter, document));
        //     }
        //     return this.converter.toIncomingLocations(document, result);
        // }
        // return next(document, position, token);
        return undefined;
    }

    public handleDiagnostics(uri: Uri, diagnostics: Diagnostic[], next: HandleDiagnosticsSignature) {
        // Remap any wrapped documents so that diagnostics appear in the cells. Note that if we
        // get a diagnostics list for our concated document, we have to tell VS code about EVERY cell.
        // Otherwise old messages for cells that didn't change this time won't go away.
        const newDiagMapping = this.converter.toIncomingDiagnosticsMap(uri, diagnostics);
        [...newDiagMapping.keys()].forEach((k) => next(k, newDiagMapping.get(k)!));
    }
}
