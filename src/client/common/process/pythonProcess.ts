// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import { PythonExecInfo } from '../../pythonEnvironments/exec';
import { ErrorUtils } from '../errors/errorUtils';
import { ModuleNotInstalledError } from '../errors/moduleNotInstalledError';
import * as internalPython from './internal/python';
import {
    ExecutionResult,
    IProcessService,
    ObservableExecutionResult,
    PythonExecutionInfo,
    SpawnOptions
} from './types';

class PythonProcessService {
    constructor(
        // This is the externally defined functionality used by the class.
        private readonly deps: {
            // from PythonEnvironment:
            isModuleInstalled(moduleName: string): Promise<boolean>;
            getExecutionInfo(pythonArgs?: string[]): PythonExecInfo;
            getExecutionObservableInfo(pythonArgs?: string[]): PythonExecInfo;
            // from ProcessService:
            exec(file: string, args: string[], options: SpawnOptions): Promise<ExecutionResult<string>>;
            execObservable(file: string, args: string[], options: SpawnOptions): ObservableExecutionResult<string>;
        }
    ) {}
    public getExecutionDetails(options: {
        args: string[];
        options: SpawnOptions;
        moduleName?: string;
    }): {
        execDetails: PythonExecutionInfo;
        execObservableDetails: PythonExecutionInfo;
        execModuleDetails?: PythonExecutionInfo;
        execModuleObservableDetails?: PythonExecutionInfo;
    } {
        const execDetails = this.getExecInfo(options.args, options.options);
        const execObservableDetails = this.getExecObservableInfo(options.args, options.options);
        const execModuleDetails = options.moduleName
            ? this.getModuleExecInfo(options.moduleName, options.args, options.options)
            : undefined;
        const execModuleObservableDetails = options.moduleName
            ? this.getModuleExecObservableInfo(options.moduleName, options.args, options.options)
            : undefined;
        return {
            execDetails,
            execObservableDetails,
            execModuleDetails,
            execModuleObservableDetails
        };
    }
    public execObservable(args: string[], options: SpawnOptions): ObservableExecutionResult<string> {
        const executable = this.getExecObservableInfo(args, options);
        return this.deps.execObservable(executable.command, executable.args, executable.options);
    }

    public execModuleObservable(
        moduleName: string,
        moduleArgs: string[],
        options: SpawnOptions
    ): ObservableExecutionResult<string> {
        const executable = this.getModuleExecObservableInfo(moduleName, moduleArgs, options);
        return this.deps.execObservable(executable.command, executable.args, executable.options);
    }

    public async exec(args: string[], options: SpawnOptions): Promise<ExecutionResult<string>> {
        const executable = this.getExecInfo(args, options);
        return this.deps.exec(executable.command, executable.args, executable.options);
    }

    public async execModule(
        moduleName: string,
        moduleArgs: string[],
        options: SpawnOptions
    ): Promise<ExecutionResult<string>> {
        const executable = this.getModuleExecInfo(moduleName, moduleArgs, options);
        const result = await this.deps.exec(executable.command, executable.args, executable.options);

        // If a module is not installed we'll have something in stderr.
        if (moduleName && ErrorUtils.outputHasModuleNotInstalledError(moduleName, result.stderr)) {
            const isInstalled = await this.deps.isModuleInstalled(moduleName);
            if (!isInstalled) {
                throw new ModuleNotInstalledError(moduleName);
            }
        }

        return result;
    }
    private getModuleExecInfo(moduleName: string, moduleArgs: string[], options: SpawnOptions): PythonExecutionInfo {
        const args = internalPython.execModule(moduleName, moduleArgs);
        const opts: SpawnOptions = { ...options };
        const executable = this.deps.getExecutionInfo(args);
        return {
            command: executable.command,
            args: executable.args,
            options: opts
        };
    }
    private getExecInfo(args: string[], options: SpawnOptions): PythonExecutionInfo {
        const opts: SpawnOptions = { ...options };
        const executable = this.deps.getExecutionInfo(args);
        return {
            command: executable.command,
            args: executable.args,
            options: opts
        };
    }
    private getModuleExecObservableInfo(
        moduleName: string,
        moduleArgs: string[],
        options: SpawnOptions
    ): PythonExecutionInfo {
        const args = internalPython.execModule(moduleName, moduleArgs);
        const opts: SpawnOptions = { ...options };
        const executable = this.deps.getExecutionObservableInfo(args);
        return {
            command: executable.command,
            args: executable.args,
            options: opts
        };
    }
    private getExecObservableInfo(args: string[], options: SpawnOptions): PythonExecutionInfo {
        const opts: SpawnOptions = { ...options };
        const executable = this.deps.getExecutionObservableInfo(args);
        return {
            command: executable.command,
            args: executable.args,
            options: opts
        };
    }
}

export function createPythonProcessService(
    procs: IProcessService,
    // from PythonEnvironment:
    env: {
        getExecutionInfo(pythonArgs?: string[]): PythonExecInfo;
        getExecutionObservableInfo(pythonArgs?: string[]): PythonExecInfo;
        isModuleInstalled(moduleName: string): Promise<boolean>;
    }
) {
    const deps = {
        // from PythonService:
        isModuleInstalled: async (m: string) => env.isModuleInstalled(m),
        getExecutionInfo: (a?: string[]) => env.getExecutionInfo(a),
        getExecutionObservableInfo: (a?: string[]) => env.getExecutionObservableInfo(a),
        // from ProcessService:
        exec: async (f: string, a: string[], o: SpawnOptions) => procs.exec(f, a, o),
        execObservable: (f: string, a: string[], o: SpawnOptions) => procs.execObservable(f, a, o)
    };
    return new PythonProcessService(deps);
}
