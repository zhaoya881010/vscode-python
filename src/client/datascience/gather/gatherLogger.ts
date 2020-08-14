import { inject, injectable } from 'inversify';
import { extensions } from 'vscode';
import { traceError } from '../../common/logger';
import { IConfigurationService } from '../../common/types';
import { noop } from '../../common/utils/misc';
import { sendTelemetryEvent } from '../../telemetry';
import { CellMatcher } from '../cellMatcher';
import { GatherExtension, Identifiers, Telemetry } from '../constants';
import { IExecuteOptions, IExecuteResult, IGatherLogger, IGatherProvider } from '../types';

@injectable()
export class GatherLogger implements IGatherLogger {
    private gather: IGatherProvider | undefined;
    constructor(@inject(IConfigurationService) private configService: IConfigurationService) {
        this.initGatherExtension().ignoreErrors();
    }

    public dispose() {
        noop();
    }
    public onKernelRestarted() {
        noop();
    }

    public async preExecute(_options: IExecuteOptions): Promise<void> {
        // This function is just implemented here for compliance with the INotebookExecutionLogger interface
        noop();
    }

    public async postExecute(options: IExecuteOptions, result: IExecuteResult): Promise<void> {
        if (this.gather) {
            // Don't log if vscCell.data.source is an empty string or if it was
            // silently executed. Original Jupyter extension also does this.
            if (options.code !== '' && !options.silent) {
                // Strip first line marker. We can't do this at JupyterServer.executeCodeObservable because it messes up hashing
                const cellMatcher = new CellMatcher(this.configService.getSettings().datascience);
                const code = cellMatcher.stripFirstMarker(options.code);

                try {
                    this.gather.logExecution({
                        id: options.id,
                        file: options.file || Identifiers.EmptyFileName,
                        line: 0,
                        state: result.state,
                        data: {
                            cell_type: 'code',
                            outputs: result.outputs,
                            execution_count: result.execution_count,
                            metadata: options.metadata || {},
                            source: code
                        }
                    });
                } catch (e) {
                    traceError('Gather: Exception at Log Execution', e);
                    sendTelemetryEvent(Telemetry.GatherException, undefined, { exceptionType: 'log' });
                }
            }
        }
    }

    public getGatherProvider(): IGatherProvider | undefined {
        return this.gather;
    }

    private async initGatherExtension() {
        const ext = extensions.getExtension(GatherExtension);
        if (ext) {
            sendTelemetryEvent(Telemetry.GatherIsInstalled);
            if (!ext.isActive) {
                try {
                    await ext.activate();
                } catch (e) {
                    traceError('Gather: Exception at Activate', e);
                    sendTelemetryEvent(Telemetry.GatherException, undefined, { exceptionType: 'activate' });
                }
            }
            const api = ext.exports;
            this.gather = api.getGatherProvider();
        }
    }
}
