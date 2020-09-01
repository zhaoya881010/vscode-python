// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.
import * as path from 'path';
import * as uuid from 'uuid/v4';
import {
    CodeAction,
    CodeActionContext,
    CodeLens,
    Command,
    CompletionItem,
    CompletionList,
    Diagnostic,
    DiagnosticRelatedInformation,
    DocumentHighlight,
    DocumentSelector,
    DocumentSymbol,
    EndOfLine,
    Hover,
    Location,
    LocationLink,
    NotebookConcatTextDocument,
    NotebookDocument,
    Position,
    Range,
    SymbolInformation,
    TextDocument,
    TextDocumentChangeEvent,
    TextDocumentContentChangeEvent,
    TextEdit,
    Uri,
    WorkspaceEdit
} from 'vscode';
import { IVSCodeNotebook } from '../../common/application/types';
import { HiddenFileFormatString } from '../../constants';

/**
 * This helper class is used to present a converted document to an LS and provide conversion functions
 * for middleware results.
 */
export class NotebookConcatConverter implements TextDocument {
    public get notebookUri() {
        return this.notebookDoc.uri;
    }

    public get uri() {
        return this.dummyUri;
    }

    public get fileName() {
        return this.dummyFilePath;
    }

    public get isUntitled() {
        return this.notebookDoc.isUntitled;
    }

    public get languageId() {
        return this.notebookDoc.languages[0];
    }

    public get version() {
        return this._version;
    }

    public get isDirty() {
        return this.notebookDoc.isDirty;
    }

    public get isClosed() {
        return this.concatDocument.isClosed;
    }
    public get eol() {
        return EndOfLine.LF;
    }
    public get lineCount() {
        return this.notebookDoc.cells.map((c) => c.document.lineCount).reduce((p, c) => p + c);
    }
    public get firedClose() {
        return this._firedClose;
    }

    public set firedClose(val: boolean) {
        this._firedClose = val;
        NotebookConcatConverter.ActiveConverters = NotebookConcatConverter.ActiveConverters.filter((c) => c !== this);
    }
    private static ActiveConverters: NotebookConcatConverter[] = [];
    public firedOpen = false;
    private concatDocument: NotebookConcatTextDocument;
    private dummyFilePath: string;
    private dummyUri: Uri;
    private _firedClose = false;
    private _version = 1;
    constructor(
        private notebookDoc: NotebookDocument,
        private notebookApi: IVSCodeNotebook,
        selector: DocumentSelector
    ) {
        const dir = path.dirname(notebookDoc.uri.fsPath);
        this.dummyFilePath = path.join(dir, HiddenFileFormatString.format(uuid().replace(/-/g, '')));
        this.dummyUri = Uri.file(this.dummyFilePath);
        this.concatDocument = this.notebookApi.createConcatTextDocument(notebookDoc, selector);
        this.concatDocument.onDidChange(this.onDidChange.bind(this));
    }

    public static toIncomingWorkspaceEdit(workspaceEdit: WorkspaceEdit | null | undefined) {
        if (workspaceEdit) {
            // Translate all of the text edits
            const result = new WorkspaceEdit();
            const translated = workspaceEdit.entries().map();
        }
        return workspaceEdit;
    }

    public isCellOfDocument(uri: Uri) {
        return this.concatDocument.contains(uri);
    }
    public save(): Thenable<boolean> {
        // Not used
        throw new Error('Not implemented');
    }
    public lineAt(posOrNumber: Position | number) {
        const position = typeof posOrNumber === 'number' ? new Position(posOrNumber, 0) : posOrNumber;
        // convert this position into a cell position
        const location = this.concatDocument.locationAt(position);

        // Get the cell at this location
        const cell = this.notebookDoc.cells.find((c) => c.uri.toString() === location.uri.toString());
        return cell!.document.lineAt(location.range.start);
    }

    public offsetAt(position: Position) {
        return this.concatDocument.offsetAt(position);
    }

    public positionAt(offset: number) {
        return this.concatDocument.positionAt(offset);
    }

    public getText(range?: Range | undefined) {
        return range ? this.concatDocument.getText(range) : this.concatDocument.getText();
    }

    public getWordRangeAtPosition(position: Position, regexp?: RegExp | undefined) {
        // convert this position into a cell position
        const location = this.concatDocument.locationAt(position);

        // Get the cell at this location
        const cell = this.notebookDoc.cells.find((c) => c.uri.toString() === location.uri.toString());
        return cell!.document.getWordRangeAtPosition(location.range.start, regexp);
    }

    public validateRange(range: Range) {
        return this.concatDocument.validateRange(range);
    }

    public validatePosition(pos: Position) {
        return this.concatDocument.validatePosition(pos);
    }

    public getConcatDocument(cell: TextDocument) {
        if (this.isCellOfDocument(cell.uri)) {
            return this;
        }
        return cell;
    }

    public getCellAtPosition(position: Position) {
        const location = this.concatDocument.locationAt(position);
        return this.notebookDoc.cells.find((c) => c.uri === location.uri);
    }

    public toOutgoingChangeEvent(cellEvent: TextDocumentChangeEvent) {
        return {
            document: this.getConcatDocument(cellEvent.document),
            contentChanges: cellEvent.contentChanges.map(
                this.toOutgoingContentChangeEvent.bind(this, cellEvent.document)
            )
        };
    }

    public toOutgoingPosition(cell: TextDocument, position: Position) {
        return this.concatDocument.positionAt(new Location(cell.uri, position));
    }

    public toOutgoingRange(cell: TextDocument, cellRange: Range): Range {
        const startPos = this.concatDocument.positionAt(new Location(cell.uri, cellRange.start));
        const endPos = this.concatDocument.positionAt(new Location(cell.uri, cellRange.end));
        return new Range(startPos, endPos);
    }

    public toOutgoingOffset(cell: TextDocument, offset: number) {
        const position = cell.positionAt(offset);
        const overallPosition = this.concatDocument.positionAt(new Location(cell.uri, position));
        return this.concatDocument.offsetAt(overallPosition);
    }

    public toOutgoingContext(cell: TextDocument, context: CodeActionContext): CodeActionContext {
        return {
            ...context,
            diagnostics: context.diagnostics.map(this.toOutgoingDiagnostic.bind(this, cell))
        };
    }

    public toIncomingHover(_cell: TextDocument, hover: Hover | null | undefined) {
        if (hover && hover.range) {
            return {
                ...hover,
                range: this.toIncomingRange(hover.range)
            };
        }
        return hover;
    }
    public toIncomingCompletions(
        _cell: TextDocument,
        completions: CompletionItem[] | CompletionList | null | undefined
    ) {
        if (completions) {
            if (Array.isArray(completions)) {
                return completions.map(this.toIncomingCompletion.bind(this));
            } else {
                return {
                    ...completions,
                    items: completions.items.map(this.toIncomingCompletion.bind(this))
                };
            }
        }
        return completions;
    }

    public toIncomingLocation(cell: TextDocument, location: Location | Location[] | LocationLink[] | null | undefined) {
        if (Array.isArray(location)) {
            // tslint:disable-next-line: no-any
            return (<any>location).map(this.toIncomingLocationFromLink.bind(this, cell));
        } else if (location?.range) {
            return {
                ...location,
                range: this.toIncomingRange(location.range)
            };
        }
        return location;
    }

    public toIncomingHighlight(_cell: TextDocument, highlight: DocumentHighlight[] | null | undefined) {
        if (highlight) {
            return highlight.map((h) => {
                return {
                    ...h,
                    range: this.toIncomingRange(h.range)
                };
            });
        }
        return highlight;
    }

    public toIncomingSymbols(cell: TextDocument, symbols: SymbolInformation[] | DocumentSymbol[] | null | undefined) {
        if (symbols && Array.isArray(symbols) && symbols.length) {
            if (symbols[0] instanceof DocumentSymbol) {
                return (<DocumentSymbol[]>symbols).map(this.toIncomingSymbolFromDocumentSymbol.bind(this));
            } else {
                return (<SymbolInformation[]>symbols).map(this.toIncomingSymbolFromSymbolInformation.bind(this, cell));
            }
        }
        return symbols;
    }

    public toIncomingSymbolFromSymbolInformation(cell: TextDocument, symbol: SymbolInformation): SymbolInformation {
        return {
            ...symbol,
            location: this.toIncomingLocation(cell, symbol.location)
        };
    }

    public toIncomingDiagnostic(cell: TextDocument, diagnostic: Diagnostic): Diagnostic {
        return {
            ...diagnostic,
            range: this.toIncomingRange(diagnostic.range),
            relatedInformation: diagnostic.relatedInformation
                ? diagnostic.relatedInformation.map(this.toIncomingRelatedInformation.bind(this, cell))
                : undefined
        };
    }

    public toIncomingActions(cell: TextDocument, actions: (Command | CodeAction)[] | null | undefined) {
        if (Array.isArray(actions)) {
            return actions.map(this.toIncomingAction.bind(this, cell));
        }
        return actions;
    }

    public toIncomingCodeLenses(_cell: TextDocument, lenses: CodeLens[] | null | undefined) {
        if (Array.isArray(lenses)) {
            return lenses.map((c) => {
                return {
                    ...c,
                    range: this.toIncomingRange(c.range)
                };
            });
        }
        return lenses;
    }

    public toIncomingEdits(_cell: TextDocument, edits: TextEdit[] | null | undefined) {
        if (Array.isArray(edits)) {
            return edits.map((e) => {
                return {
                    ...e,
                    range: this.toIncomingRange(e.range)
                };
            });
        }
        return edits;
    }

    private toIncomingAction(cell: TextDocument, action: Command | CodeAction): Command | CodeAction {
        if (action instanceof CodeAction) {
            return {
                ...action,
                diagnostics: action.diagnostics
                    ? action.diagnostics.map(this.toIncomingDiagnostic.bind(cell, this))
                    : undefined
            };
        }
        return action;
    }

    private toOutgoingDiagnostic(cell: TextDocument, diagnostic: Diagnostic): Diagnostic {
        return {
            ...diagnostic,
            range: this.toOutgoingRange(cell, diagnostic.range),
            relatedInformation: diagnostic.relatedInformation
                ? diagnostic.relatedInformation.map(this.toOutgoingRelatedInformation.bind(this, cell))
                : undefined
        };
    }

    private toOutgoingRelatedInformation(
        cell: TextDocument,
        relatedInformation: DiagnosticRelatedInformation
    ): DiagnosticRelatedInformation {
        return {
            ...relatedInformation,
            location:
                relatedInformation.location.uri === this.uri
                    ? this.toOutgoingLocation(cell, relatedInformation.location)
                    : relatedInformation.location
        };
    }

    private toOutgoingLocation(cell: TextDocument, location: Location): Location {
        return {
            uri: this.uri,
            range: this.toOutgoingRange(cell, location.range)
        };
    }

    private toIncomingRelatedInformation(
        cell: TextDocument,
        relatedInformation: DiagnosticRelatedInformation
    ): DiagnosticRelatedInformation {
        return {
            ...relatedInformation,
            location:
                relatedInformation.location.uri === this.uri
                    ? this.toIncomingLocationFromLink(cell, relatedInformation.location)
                    : relatedInformation.location
        };
    }

    private toIncomingSymbolFromDocumentSymbol(docSymbol: DocumentSymbol): DocumentSymbol {
        return {
            ...docSymbol,
            range: this.toIncomingRange(docSymbol.range),
            selectionRange: this.toIncomingRange(docSymbol.selectionRange),
            children: docSymbol.children.map(this.toIncomingSymbolFromDocumentSymbol.bind(this))
        };
    }

    private toIncomingLocationFromLink(cell: TextDocument, location: Location | LocationLink) {
        const locationLink = <LocationLink>location;
        const locationNorm = <Location>location;
        return {
            originSelectionRange: locationLink.originSelectionRange
                ? this.toIncomingRange(locationLink.originSelectionRange)
                : undefined,
            uri: cell.uri,
            range: locationLink.targetRange
                ? this.toIncomingRange(locationLink.targetRange)
                : this.toIncomingRange(locationNorm.range),
            targetSelectionRange: locationLink.targetSelectionRange
                ? this.toIncomingRange(locationLink.targetSelectionRange)
                : undefined
        };
    }

    private toIncomingCompletion(item: CompletionItem) {
        if (item.range) {
            if (item.range instanceof Range) {
                return {
                    ...item,
                    range: this.toIncomingRange(item.range)
                };
            } else {
                return {
                    ...item,
                    range: {
                        inserting: this.toIncomingRange(item.range.inserting),
                        replacing: this.toIncomingRange(item.range.replacing)
                    }
                };
            }
        }
        return item;
    }

    private toIncomingRange(range: Range) {
        const startLoc = this.concatDocument.locationAt(range.start);
        const endLoc = this.concatDocument.locationAt(range.end);
        return new Range(startLoc.range.start, endLoc.range.end);
    }

    private toOutgoingContentChangeEvent(cell: TextDocument, ev: TextDocumentContentChangeEvent) {
        return {
            range: this.toOutgoingRange(cell, ev.range),
            rangeLength: ev.rangeLength,
            rangeOffset: this.toOutgoingOffset(cell, ev.rangeOffset),
            text: ev.text
        };
    }

    private onDidChange() {
        this._version += 1;
    }
}
