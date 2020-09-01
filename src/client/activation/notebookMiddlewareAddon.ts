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
    DocumentHighlight,
    DocumentLink,
    DocumentSelector,
    DocumentSymbol,
    FormattingOptions,
    Location,
    notebook,
    NotebookDocument,
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
import { IVSCodeNotebook } from '../common/application/types';
import { isNotebookCell } from '../common/utils/misc';
import { NotebookConcatConverter } from './notebookConcatConverter';

/**
 * This class is a temporary solution to handling intellisense and diagnostics in python based notebooks.
 *
 * It is responsible for generating a concatenated document of all of the cells in a notebook and using that as the
 * document for LSP requests.
 */
export class NotebookMiddlewareAddon implements Middleware {
    private converters: NotebookConcatConverter[] = [];

    constructor(private notebookApi: IVSCodeNotebook, private selector: DocumentSelector) {
        notebook.onDidOpenNotebookDocument(this.onDidOpenNotebook.bind(this));
        notebook.onDidCloseNotebookDocument(this.onDidCloseNotebook.bind(this));
    }

    public didChange(event: TextDocumentChangeEvent, next: (ev: TextDocumentChangeEvent) => void) {
        // If this is a notebook cell, change this into a concat document event
        if (isNotebookCell(event.document.uri)) {
            const converter = this.getConverter(event.document);
            if (converter) {
                const newEvent = converter.toOutgoingChangeEvent(event);
                return next(newEvent);
            }
        } else {
            next(event);
        }
    }

    public didOpen(document: TextDocument, next: (ev: TextDocument) => void) {
        // If this is a notebook cell, change this into a concat document if this is the first time.
        if (isNotebookCell(document.uri)) {
            const converter = this.getConverter(document);
            if (converter && !converter.firedOpen) {
                converter.firedOpen = true;
                const newDoc = converter.getConcatDocument(document);
                return next(newDoc);
            }
        } else {
            next(document);
        }
    }

    public didClose(document: TextDocument, next: (ev: TextDocument) => void) {
        // If this is a notebook cell, change this into a concat document if this is the first time.
        // TODO: Does this get fired when deleting a cell?
        if (isNotebookCell(document.uri)) {
            const converter = this.getConverter(document);
            if (converter && converter.firedOpen && converter.firedClose) {
                converter.firedClose = true;
                converter.firedOpen = false;
                const newDoc = converter.getConcatDocument(document);
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
            const converter = this.getConverter(document);
            if (converter) {
                const newDoc = converter.getConcatDocument(document);
                const newPos = converter.toOutgoingPosition(document, position);
                return next(newDoc, newPos, context, token);
            }
        }
        return next(document, position, context, token);
    }

    public provideHover(
        document: TextDocument,
        position: Position,
        token: CancellationToken,
        next: ProvideHoverSignature
    ) {
        return next(document, position, token);
    }

    public resolveCompletionItem(
        item: CompletionItem,
        token: CancellationToken,
        next: ResolveCompletionItemSignature
    ): ProviderResult<CompletionItem> {
        return next(item, token);
    }

    public provideSignatureHelp(
        document: TextDocument,
        position: Position,
        context: SignatureHelpContext,
        token: CancellationToken,
        next: ProvideSignatureHelpSignature
    ): ProviderResult<SignatureHelp> {
        return next(document, position, context, token);
    }

    public provideDefinition(
        document: TextDocument,
        position: Position,
        token: CancellationToken,
        next: ProvideDefinitionSignature
    ): ProviderResult<Definition | DefinitionLink[]> {
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
        return next(document, position, options, token);
    }

    public provideDocumentHighlights(
        document: TextDocument,
        position: Position,
        token: CancellationToken,
        next: ProvideDocumentHighlightsSignature
    ): ProviderResult<DocumentHighlight[]> {
        return next(document, position, token);
    }

    public provideDocumentSymbols(
        document: TextDocument,
        token: CancellationToken,
        next: ProvideDocumentSymbolsSignature
    ): ProviderResult<SymbolInformation[] | DocumentSymbol[]> {
        return next(document, token);
    }

    public provideWorkspaceSymbols(
        query: string,
        token: CancellationToken,
        next: ProvideWorkspaceSymbolsSignature
    ): ProviderResult<SymbolInformation[]> {
        return next(query, token);
    }

    public provideCodeActions(
        document: TextDocument,
        range: Range,
        context: CodeActionContext,
        token: CancellationToken,
        next: ProvideCodeActionsSignature
    ): ProviderResult<(Command | CodeAction)[]> {
        return next(document, range, context, token);
    }

    public provideCodeLenses(
        document: TextDocument,
        token: CancellationToken,
        next: ProvideCodeLensesSignature
    ): ProviderResult<CodeLens[]> {
        return next(document, token);
    }

    public resolveCodeLens(
        codeLens: CodeLens,
        token: CancellationToken,
        next: ResolveCodeLensSignature
    ): ProviderResult<CodeLens> {
        return next(codeLens, token);
    }

    public provideDocumentFormattingEdits(
        document: TextDocument,
        options: FormattingOptions,
        token: CancellationToken,
        next: ProvideDocumentFormattingEditsSignature
    ): ProviderResult<TextEdit[]> {
        return next(document, options, token);
    }

    public provideDocumentRangeFormattingEdits(
        document: TextDocument,
        range: Range,
        options: FormattingOptions,
        token: CancellationToken,
        next: ProvideDocumentRangeFormattingEditsSignature
    ): ProviderResult<TextEdit[]> {
        return next(document, range, options, token);
    }

    public provideOnTypeFormattingEdits(
        document: TextDocument,
        position: Position,
        ch: string,
        options: FormattingOptions,
        token: CancellationToken,
        next: ProvideOnTypeFormattingEditsSignature
    ): ProviderResult<TextEdit[]> {
        return next(document, position, ch, options, token);
    }

    public provideRenameEdits(
        document: TextDocument,
        position: Position,
        newName: string,
        token: CancellationToken,
        next: ProvideRenameEditsSignature
    ): ProviderResult<WorkspaceEdit> {
        return next(document, position, newName, token);
    }

    public prepareRename(
        document: TextDocument,
        position: Position,
        token: CancellationToken,
        next: PrepareRenameSignature
    ): ProviderResult<
        | Range
        | {
              range: Range;
              placeholder: string;
          }
    > {
        return next(document, position, token);
    }

    public provideDocumentLinks(
        document: TextDocument,
        token: CancellationToken,
        next: ProvideDocumentLinksSignature
    ): ProviderResult<DocumentLink[]> {
        return next(document, token);
    }

    public resolveDocumentLink(
        link: DocumentLink,
        token: CancellationToken,
        next: ResolveDocumentLinkSignature
    ): ProviderResult<DocumentLink> {
        return next(link, token);
    }

    public provideDeclaration(
        document: TextDocument,
        position: VPosition,
        token: CancellationToken,
        next: ProvideDeclarationSignature
    ): ProviderResult<VDeclaration> {
        return next(document, position, token);
    }

    public handleDiagnostics(uri: Uri, diagnostics: Diagnostic[], next: HandleDiagnosticsSignature) {
        return next(uri, diagnostics);
    }

    private onDidOpenNotebook(doc: NotebookDocument) {
        this.converters.push(new NotebookConcatConverter(doc, this.notebookApi, this.selector));
    }

    private onDidCloseNotebook(doc: NotebookDocument) {
        const index = this.converters.findIndex((c) => c.notebookUri === doc.uri);
        if (index >= 0) {
            this.converters.splice(index, 1);
        }
    }

    private getConverter(doc: TextDocument) {
        return this.converters.find((c) => c.isCellOfDocument(doc.uri));
    }
}
