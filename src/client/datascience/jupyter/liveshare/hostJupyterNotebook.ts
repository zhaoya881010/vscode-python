// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.
'use strict';
import { Observable } from 'rxjs/Observable';
import * as vscode from 'vscode';
import { CancellationToken } from 'vscode-jsonrpc';
import * as vsls from 'vsls/vscode';
import { IApplicationShell, ILiveShareApi, IWorkspaceService } from '../../../common/application/types';
import '../../../common/extensions';
import { traceError } from '../../../common/logger';

import { IConfigurationService, IDisposableRegistry, Resource } from '../../../common/types';
import { createDeferred } from '../../../common/utils/async';
import { Identifiers, LiveShare, LiveShareCommands } from '../../constants';
import {
    ICell,
    IDataScienceFileSystem,
    IExecuteOptions,
    IExecuteResult,
    IJupyterSession,
    INotebook,
    INotebookExecutionInfo,
    INotebookExecutionLogger,
    InterruptResult
} from '../../types';
import { JupyterNotebook } from '../jupyterNotebook';
import { LiveShareParticipantHost } from './liveShareParticipantMixin';
import { ResponseQueue } from './responseQueue';
import { IRoleBasedObject } from './roleBasedFactory';
import { IResponseMapping, IServerResponse, ServerResponseType } from './types';

// tslint:disable-next-line: no-require-imports
import cloneDeep = require('lodash/cloneDeep');

// tslint:disable:no-any

export class HostJupyterNotebook
    extends LiveShareParticipantHost(JupyterNotebook, LiveShare.JupyterNotebookSharedService)
    implements IRoleBasedObject, INotebook {
    private catchupResponses: ResponseQueue = new ResponseQueue();
    private localResponses: ResponseQueue = new ResponseQueue();
    private requestLog: Map<string, number> = new Map<string, number>();
    private catchupPendingCount: number = 0;
    private isDisposed = false;
    constructor(
        _liveShare: ILiveShareApi,
        session: IJupyterSession,
        configService: IConfigurationService,
        disposableRegistry: IDisposableRegistry,
        executionInfo: INotebookExecutionInfo,
        loggers: INotebookExecutionLogger[],
        resource: Resource,
        identity: vscode.Uri,
        getDisposedError: () => Error,
        workspace: IWorkspaceService,
        appService: IApplicationShell,
        fs: IDataScienceFileSystem
    ) {
        super(
            session,
            configService,
            disposableRegistry,
            executionInfo,
            loggers,
            resource,
            identity,
            getDisposedError,
            workspace,
            appService,
            fs
        );
    }

    public dispose = async (): Promise<void> => {
        if (!this.isDisposed) {
            this.isDisposed = true;
            await super.dispose();
            const api = await this.api;
            return this.onDetach(api);
        }
    };

    public async onAttach(api: vsls.LiveShare | null): Promise<void> {
        await super.onAttach(api);

        if (api && !this.isDisposed) {
            const service = await this.waitForService();

            // Attach event handlers to different requests
            if (service) {
                // Requests return arrays
                service.onRequest(LiveShareCommands.syncRequest, (_args: any[], _cancellation: CancellationToken) =>
                    this.onSync()
                );
                service.onRequest(LiveShareCommands.getSysInfo, (_args: any[], cancellation: CancellationToken) =>
                    this.onGetSysInfoRequest(cancellation)
                );
                service.onRequest(LiveShareCommands.inspect, (args: any[], cancellation: CancellationToken) =>
                    this.inspect(args[0], 0, cancellation)
                );
                service.onRequest(LiveShareCommands.restart, (args: any[], cancellation: CancellationToken) =>
                    this.onRestartRequest(
                        args.length > 0 ? (args[0] as number) : LiveShare.InterruptDefaultTimeout,
                        cancellation
                    )
                );
                service.onRequest(LiveShareCommands.interrupt, (args: any[], cancellation: CancellationToken) =>
                    this.onInterruptRequest(
                        args.length > 0 ? (args[0] as number) : LiveShare.InterruptDefaultTimeout,
                        cancellation
                    )
                );
                service.onRequest(LiveShareCommands.disposeServer, (_args: any[], _cancellation: CancellationToken) =>
                    this.dispose()
                );

                // Notifications are always objects.
                service.onNotify(LiveShareCommands.catchupRequest, (args: object) => this.onCatchupRequest(args));
                service.onNotify(LiveShareCommands.executeObservable, (args: object) =>
                    this.onExecuteObservableRequest(args as IExecuteOptions)
                );
            }
        }
    }

    public async waitForServiceName(): Promise<string> {
        // Use our base name plus our id. This means one unique server per notebook
        // Convert to our shared URI to match the guest and remove any '.' as live share won't support them
        const sharedUri =
            this.identity.scheme === 'file' ? this.finishedApi!.convertLocalUriToShared(this.identity) : this.identity;
        return Promise.resolve(`${LiveShare.JupyterNotebookSharedService}${sharedUri.toString()}`);
    }

    public async onPeerChange(ev: vsls.PeersChangeEvent): Promise<void> {
        await super.onPeerChange(ev);

        // Keep track of the number of guests that need to do a catchup request
        this.catchupPendingCount +=
            ev.added.filter((e) => e.role === vsls.Role.Guest).length -
            ev.removed.filter((e) => e.role === vsls.Role.Guest).length;
    }

    public clear(id: string): void {
        this.requestLog.delete(id);
    }

    public executeObservable(options: IExecuteOptions): Observable<IExecuteResult> {
        // See if this has already been asked for not
        if (this.requestLog.has(options.id)) {
            // This must be a local call that occurred after a guest call. Just
            // use the local responses to return the results.
            return this.localResponses.waitForObservable(options.code, options.id);
        } else {
            // Otherwise make a new request and save response in the catchup list. THis is a
            // a request that came directly from the host so the host will be listening to the observable returned
            // and we don't need to save the response in the local queue.
            return this.makeObservableRequest(options, [this.catchupResponses]);
        }
    }

    public async restartKernel(timeoutMs: number): Promise<void> {
        try {
            await super.restartKernel(timeoutMs);
        } catch (exc) {
            this.postException(exc, []);
            throw exc;
        }
    }

    public async interruptKernel(timeoutMs: number): Promise<InterruptResult> {
        try {
            return super.interruptKernel(timeoutMs);
        } catch (exc) {
            this.postException(exc, []);
            throw exc;
        }
    }

    private makeRequest(options: IExecuteOptions, responseQueues: ResponseQueue[]): Promise<IExecuteResult> {
        // Create a deferred that we'll fire when we're done
        const deferred = createDeferred<IExecuteResult>();

        // Attempt to evaluate this cell in the jupyter notebook
        const observable = this.makeObservableRequest(options, responseQueues);
        let output: IExecuteResult;

        observable.subscribe(
            (result: IExecuteResult) => {
                output = result;
            },
            (error) => {
                deferred.reject(error);
            },
            () => {
                deferred.resolve(output);
            }
        );

        // Wait for the execution to finish
        return deferred.promise;
    }

    private makeObservableRequest(
        options: IExecuteOptions,
        responseQueues: ResponseQueue[]
    ): Observable<IExecuteResult> {
        try {
            this.requestLog.set(options.id, Date.now());
            const inner = super.executeObservable(options);

            // Cleanup old requests
            const now = Date.now();
            for (const [k, val] of this.requestLog) {
                if (now - val > LiveShare.ResponseLifetime) {
                    this.requestLog.delete(k);
                }
            }

            // Wrap the observable returned to send the responses to the guest(s) too.
            return this.postObservableResult(options.code, inner, options.id, responseQueues);
        } catch (exc) {
            this.postException(exc, responseQueues);
            throw exc;
        }
    }

    private translateCellForGuest(cell: ICell): ICell {
        const copy = { ...cell };
        if (this.role === vsls.Role.Host && this.finishedApi && copy.file !== Identifiers.EmptyFileName) {
            copy.file = this.finishedApi.convertLocalUriToShared(vscode.Uri.file(copy.file)).fsPath;
        }
        return copy;
    }

    private onSync(): Promise<any> {
        return Promise.resolve(true);
    }

    private onGetSysInfoRequest(_cancellation: CancellationToken): Promise<any> {
        // Get the sys info from our local server
        return super.getSysInfo();
    }

    private onRestartRequest(timeout: number, _cancellation: CancellationToken): Promise<any> {
        // Just call the base
        return super.restartKernel(timeout);
    }
    private onInterruptRequest(timeout: number, _cancellation: CancellationToken): Promise<any> {
        // Just call the base
        return super.interruptKernel(timeout);
    }

    private async onCatchupRequest(args: object): Promise<void> {
        if (args.hasOwnProperty('since')) {
            const service = await this.waitForService();
            if (service) {
                // Send results for all responses that are left.
                this.catchupResponses.send(service, (r) => r);

                // Eliminate old responses if possible.
                this.catchupPendingCount -= 1;
                if (this.catchupPendingCount <= 0) {
                    this.catchupResponses.clear();
                }
            }
        }
    }

    private onExecuteObservableRequest(options: IExecuteOptions) {
        // See if we started this execute or not already.
        if (options.code) {
            if (!this.requestLog.has(options.id)) {
                try {
                    // Convert the file name if necessary
                    const uri = vscode.Uri.parse(`vsls:${options.file}`);
                    const file =
                        this.finishedApi && options.file && options.file !== Identifiers.EmptyFileName
                            ? this.finishedApi.convertSharedUriToLocal(uri).fsPath
                            : options.file;

                    // We need the results of this execute to end up in both the guest responses and the local responses
                    this.makeRequest({ ...options, file }, [this.localResponses, this.catchupResponses]).ignoreErrors();
                } catch (e) {
                    traceError(e);
                }
            }
        }
    }

    private postObservableResult(
        code: string,
        observable: Observable<IExecuteResult>,
        id: string,
        responseQueues: ResponseQueue[]
    ): Observable<IExecuteResult> {
        return new Observable((subscriber) => {
            let pos = 0;

            // Listen to all of the events on the observable passed in.
            observable.subscribe(
                (result) => {
                    // Forward to the next listener
                    subscriber.next(result);

                    // Send across to the guest side
                    try {
                        this.postObservableNext(code, pos, result, id, responseQueues);
                        pos += 1;
                    } catch (e) {
                        subscriber.error(e);
                        this.postException(e, responseQueues);
                    }
                },
                (e) => {
                    subscriber.error(e);
                    this.postException(e, responseQueues);
                },
                () => {
                    subscriber.complete();
                    this.postObservableComplete(code, pos, id, responseQueues);
                }
            );
        });
    }

    private postObservableNext(
        code: string,
        pos: number,
        result: IExecuteResult,
        id: string,
        responseQueues: ResponseQueue[]
    ) {
        this.postResult(
            ServerResponseType.ExecuteObservable,
            { code, pos, type: ServerResponseType.ExecuteObservable, result, id, time: Date.now() },
            (r) => r,
            responseQueues
        );
    }

    private postObservableComplete(code: string, pos: number, id: string, responseQueues: ResponseQueue[]) {
        this.postResult(
            ServerResponseType.ExecuteObservable,
            { code, pos, type: ServerResponseType.ExecuteObservable, result: undefined, id, time: Date.now() },
            (r) => r,
            responseQueues
        );
    }

    private postException(exc: any, responseQueues: ResponseQueue[]) {
        this.postResult(
            ServerResponseType.Exception,
            { type: ServerResponseType.Exception, time: Date.now(), message: exc.toString() },
            (r) => r,
            responseQueues
        );
    }

    private postResult<R extends IResponseMapping, T extends keyof R>(
        _type: T,
        result: R[T],
        guestTranslator: (r: IServerResponse) => IServerResponse,
        responseQueues: ResponseQueue[]
    ): void {
        const typedResult = (result as any) as IServerResponse;
        if (typedResult) {
            try {
                // Make a deep copy before we send. Don't want local copies being modified
                const deepCopy = cloneDeep(typedResult);
                this.waitForService()
                    .then((s) => {
                        if (s) {
                            s.notify(LiveShareCommands.serverResponse, guestTranslator(deepCopy));
                        }
                    })
                    .ignoreErrors();

                // Need to also save in memory for those guests that are in the middle of starting up
                responseQueues.forEach((r) => r.push(deepCopy));
            } catch (exc) {
                traceError(exc);
            }
        }
    }
}
