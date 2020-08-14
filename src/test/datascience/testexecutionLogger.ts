// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.
import { injectable } from 'inversify';
import { traceInfo } from '../../client/common/logger';
import { noop } from '../../client/common/utils/misc';
import { traceExecuteResults } from '../../client/datascience/common';
import { IExecuteOptions, IExecuteResult, INotebookExecutionLogger } from '../../client/datascience/types';

@injectable()
export class TestExecutionLogger implements INotebookExecutionLogger {
    public dispose() {
        noop();
    }
    public preExecute(options: IExecuteOptions): Promise<void> {
        traceInfo(`Cell Execution for ${options.id} : \n${options.code}\n`);
        return Promise.resolve();
    }
    public postExecute(options: IExecuteOptions, result: IExecuteResult): Promise<void> {
        traceExecuteResults(`Cell Execution complete for ${options.id}\n`, result);
        return Promise.resolve();
    }
    public onKernelRestarted(): void {
        // Can ignore this.
    }
}
