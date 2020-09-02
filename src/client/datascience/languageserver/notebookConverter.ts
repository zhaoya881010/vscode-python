// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.
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
    WorkspaceEdit
} from 'vscode';
import { IVSCodeNotebook } from '../../common/application/types';
import { NotebookConcatDocument } from './notebookConcatDocument';

export class NotebookConverter {
    private activeDocuments: NotebookConcatDocument[] = [];

    constructor(private api: IVSCodeNotebook, private selector: DocumentSelector) {
        api.onDidOpenNotebookDocument(this.onDidOpenNotebook.bind(this));
        api.onDidCloseNotebookDocument(this.onDidCloseNotebook.bind(this));

        // Call open on all of the active notebooks too
        api.notebookDocuments.forEach(this.onDidOpenNotebook.bind(this));
    }

    public toIncomingWorkspaceEdit(workspaceEdit: WorkspaceEdit | null | undefined) {
        if (workspaceEdit) {
            // Translate all of the text edits
        }
        return workspaceEdit;
    }

    public toOutgoingDocument(cell: TextDocument): TextDocument {
        const result = this.activeDocuments.find((c) => c.concatDocument.contains(cell.uri));
        return result ? result : cell;
    }

    public toOutgoingChangeEvent(cellEvent: TextDocumentChangeEvent) {
        return {
            document: this.toOutgoingDocument(cellEvent.document),
            contentChanges: cellEvent.contentChanges.map(
                this.toOutgoingContentChangeEvent.bind(this, cellEvent.document)
            )
        };
    }

    public toOutgoingPosition(cell: TextDocument, position: Position) {
        return this.getConcatDocument(cell).positionAt(new Location(cell.uri, position));
    }

    public toOutgoingRange(cell: TextDocument, cellRange: Range): Range {
        const startPos = this.getConcatDocument(cell).positionAt(new Location(cell.uri, cellRange.start));
        const endPos = this.getConcatDocument(cell).positionAt(new Location(cell.uri, cellRange.end));
        return new Range(startPos, endPos);
    }

    public toOutgoingOffset(cell: TextDocument, offset: number) {
        const position = cell.positionAt(offset);
        const overallPosition = this.getConcatDocument(cell).positionAt(new Location(cell.uri, position));
        return this.getConcatDocument(cell).offsetAt(overallPosition);
    }

    public toOutgoingContext(cell: TextDocument, context: CodeActionContext): CodeActionContext {
        return {
            ...context,
            diagnostics: context.diagnostics.map(this.toOutgoingDiagnostic.bind(this, cell))
        };
    }

    public toIncomingHover(cell: TextDocument, hover: Hover | null | undefined) {
        if (hover && hover.range) {
            return {
                ...hover,
                range: this.toIncomingRange(cell, hover.range)
            };
        }
        return hover;
    }
    public toIncomingCompletions(
        cell: TextDocument,
        completions: CompletionItem[] | CompletionList | null | undefined
    ) {
        if (completions) {
            if (Array.isArray(completions)) {
                return completions.map(this.toIncomingCompletion.bind(this, cell));
            } else {
                return {
                    ...completions,
                    items: completions.items.map(this.toIncomingCompletion.bind(this, cell))
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
                range: this.toIncomingRange(cell, location.range)
            };
        }
        return location;
    }

    public toIncomingHighlight(cell: TextDocument, highlight: DocumentHighlight[] | null | undefined) {
        if (highlight) {
            return highlight.map((h) => {
                return {
                    ...h,
                    range: this.toIncomingRange(cell, h.range)
                };
            });
        }
        return highlight;
    }

    public toIncomingSymbols(cell: TextDocument, symbols: SymbolInformation[] | DocumentSymbol[] | null | undefined) {
        if (symbols && Array.isArray(symbols) && symbols.length) {
            if (symbols[0] instanceof DocumentSymbol) {
                return (<DocumentSymbol[]>symbols).map(this.toIncomingSymbolFromDocumentSymbol.bind(this, cell));
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
            range: this.toIncomingRange(cell, diagnostic.range),
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

    public toIncomingCodeLenses(cell: TextDocument, lenses: CodeLens[] | null | undefined) {
        if (Array.isArray(lenses)) {
            return lenses.map((c) => {
                return {
                    ...c,
                    range: this.toIncomingRange(cell, c.range)
                };
            });
        }
        return lenses;
    }

    public toIncomingEdits(cell: TextDocument, edits: TextEdit[] | null | undefined) {
        if (Array.isArray(edits)) {
            return edits.map((e) => {
                return {
                    ...e,
                    range: this.toIncomingRange(cell, e.range)
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
                    ? action.diagnostics.map(this.toIncomingDiagnostic.bind(this, cell))
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
        const outgoingDoc = this.toOutgoingDocument(cell);
        return {
            ...relatedInformation,
            location:
                relatedInformation.location.uri === outgoingDoc.uri
                    ? this.toOutgoingLocation(cell, relatedInformation.location)
                    : relatedInformation.location
        };
    }

    private toOutgoingLocation(cell: TextDocument, location: Location): Location {
        return {
            uri: this.toOutgoingDocument(cell).uri,
            range: this.toOutgoingRange(cell, location.range)
        };
    }

    private toIncomingRelatedInformation(
        cell: TextDocument,
        relatedInformation: DiagnosticRelatedInformation
    ): DiagnosticRelatedInformation {
        const outgoingDoc = this.toOutgoingDocument(cell);
        return {
            ...relatedInformation,
            location:
                relatedInformation.location.uri === outgoingDoc.uri
                    ? this.toIncomingLocationFromLink(cell, relatedInformation.location)
                    : relatedInformation.location
        };
    }

    private toIncomingSymbolFromDocumentSymbol(cell: TextDocument, docSymbol: DocumentSymbol): DocumentSymbol {
        return {
            ...docSymbol,
            range: this.toIncomingRange(cell, docSymbol.range),
            selectionRange: this.toIncomingRange(cell, docSymbol.selectionRange),
            children: docSymbol.children.map(this.toIncomingSymbolFromDocumentSymbol.bind(this, cell))
        };
    }

    private toIncomingLocationFromLink(cell: TextDocument, location: Location | LocationLink) {
        const locationLink = <LocationLink>location;
        const locationNorm = <Location>location;
        return {
            originSelectionRange: locationLink.originSelectionRange
                ? this.toIncomingRange(cell, locationLink.originSelectionRange)
                : undefined,
            uri: cell.uri,
            range: locationLink.targetRange
                ? this.toIncomingRange(cell, locationLink.targetRange)
                : this.toIncomingRange(cell, locationNorm.range),
            targetSelectionRange: locationLink.targetSelectionRange
                ? this.toIncomingRange(cell, locationLink.targetSelectionRange)
                : undefined
        };
    }

    private toIncomingCompletion(cell: TextDocument, item: CompletionItem) {
        if (item.range) {
            if (item.range instanceof Range) {
                return {
                    ...item,
                    range: this.toIncomingRange(cell, item.range)
                };
            } else {
                return {
                    ...item,
                    range: {
                        inserting: this.toIncomingRange(cell, item.range.inserting),
                        replacing: this.toIncomingRange(cell, item.range.replacing)
                    }
                };
            }
        }
        return item;
    }

    private toIncomingRange(cell: TextDocument, range: Range) {
        const concatDocument = this.getConcatDocument(cell);
        const startLoc = concatDocument.locationAt(range.start);
        const endLoc = concatDocument.locationAt(range.end);
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

    private onDidOpenNotebook(doc: NotebookDocument) {
        this.activeDocuments.push(new NotebookConcatDocument(doc, this.api, this.selector));
    }

    private onDidCloseNotebook(doc: NotebookDocument) {
        const index = this.activeDocuments.findIndex((c) => c.notebookUri === doc.uri);
        if (index >= 0) {
            this.activeDocuments.splice(index, 1);
        }
    }

    private getConcatDocument(cell: TextDocument): NotebookConcatTextDocument {
        return this.activeDocuments.find((c) => c.concatDocument.contains(cell.uri))!.concatDocument;
    }
}
