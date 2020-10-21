import { inject, injectable } from 'inversify';
import { IExtensionSingleActivationService } from '../../activation/types';
import { ICommandManager } from '../../common/application/types';
import { ContextKey } from '../../common/contextKey';
import { IExperimentService } from '../../common/types';

@injectable()
export class DebuggerDataViewerExperimentEnabler implements IExtensionSingleActivationService {
    constructor(
        @inject(ICommandManager) private readonly commandManager: ICommandManager,
        @inject(IExperimentService) private readonly experimentService: IExperimentService
    ) {}
    public async activate() {
        const isDataViewerExperimentEnabled = new ContextKey(
            'python.isDebuggerDataViewerExperimentEnabled',
            this.commandManager
        );
        if (await this.experimentService.inExperiment('debuggerDataViewer')) {
            await isDataViewerExperimentEnabled.set(true);
        }
    }
}
