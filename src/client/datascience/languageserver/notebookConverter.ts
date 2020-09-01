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

namespace Conversion {
    export class Incoming {
        public static toIncomingWorkspaceEdit(workspaceEdit: WorkspaceEdit | null | undefined) {
            if (workspaceEdit) {
                // Translate all of the text edits
                const result = new WorkspaceEdit();
                const translated = workspaceEdit.entries().map();
            }
            return workspaceEdit;
        }
    }
}
