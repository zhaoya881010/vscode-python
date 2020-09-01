// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.
import * as path from 'path';
import * as uuid from 'uuid/v4';
import {
    DocumentSelector,
    EndOfLine,
    Event,
    EventEmitter,
    Location,
    NotebookConcatTextDocument,
    NotebookDocument,
    Position,
    Range,
    TextDocument,
    TextDocumentChangeEvent,
    TextDocumentContentChangeEvent,
    Uri
} from 'vscode';
import { IVSCodeNotebook } from '../common/application/types';
import { HiddenFileFormatString } from '../constants';

export class NotebookConcatConverter implements TextDocument {
    public firedOpen = false;
    public firedClose = false;
    public get onDidChange(): Event<TextDocumentChangeEvent> {
        // Change event should map to the concatenated document
        return this.changed.event;
    }
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
    private concatDocument: NotebookConcatTextDocument;
    private dummyFilePath: string;
    private dummyUri: Uri;
    private _version = 0;
    private changed = new EventEmitter<TextDocumentChangeEvent>();
    constructor(
        private notebookDoc: NotebookDocument,
        private notebookApi: IVSCodeNotebook,
        selector: DocumentSelector
    ) {
        const dir = path.dirname(notebookDoc.uri.fsPath);
        this.dummyFilePath = path.join(dir, HiddenFileFormatString.format(uuid().replace(/-/g, '')));
        this.dummyUri = Uri.file(this.dummyFilePath);
        this.concatDocument = this.notebookApi.createConcatTextDocument(notebookDoc, selector);
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

    private toOutgoingContentChangeEvent(cell: TextDocument, ev: TextDocumentContentChangeEvent) {
        return {
            range: this.toOutgoingRange(cell, ev.range),
            rangeLength: ev.rangeLength,
            rangeOffset: this.toOutgoingOffset(cell, ev.rangeOffset),
            text: ev.text
        };
    }
}
