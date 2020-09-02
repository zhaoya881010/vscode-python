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
 * This helper class is used to present a converted document to an LS
 */
export class NotebookConcatDocument implements TextDocument {
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
    public concatDocument: NotebookConcatTextDocument;
    private dummyFilePath: string;
    private dummyUri: Uri;
    private _version = 1;
    constructor(private notebookDoc: NotebookDocument, notebookApi: IVSCodeNotebook, selector: DocumentSelector) {
        const dir = path.dirname(notebookDoc.uri.fsPath);
        this.dummyFilePath = path.join(dir, HiddenFileFormatString.format(uuid().replace(/-/g, '')));
        this.dummyUri = Uri.file(this.dummyFilePath);
        this.concatDocument = notebookApi.createConcatTextDocument(notebookDoc, selector);
        this.concatDocument.onDidChange(this.onDidChange.bind(this));
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

    private onDidChange() {
        this._version += 1;
    }
}
