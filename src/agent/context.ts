// Copyright (c) Microsoft. All rights reserved.
// Licensed under the MIT license. See LICENSE file in the project root for full license information.

import cfgm = require('./configuration');
import cm = require('./common');
import dm = require('./diagnostics');
import events = require('events');
import fm = require('./feedback');
import fs = require('fs');
import agentifm = require('vso-node-api/interfaces/TaskAgentInterfaces');
import baseifm = require('vso-node-api/interfaces/common/VsoBaseInterfaces');
import ifm = require('./interfaces');
import lm = require('./logging');
import os = require("os");
import path = require('path');
import tm = require('./tracing');
import um = require('./utilities');
import wapim = require('vso-node-api/WebApi');

var trace: tm.Tracing;

function ensureTrace(writer: cm.ITraceWriter) {
    if (!trace) {
        trace = new tm.Tracing(__filename, writer);
    }
}

export class WellKnownVariables {
    public static sourceFolder = cm.vars.buildSourcesDirectory;
    public static stagingFolder = cm.vars.buildStagingDirectory;
    public static buildId = cm.vars.buildId;
    public static projectId = cm.vars.systemTeamProjectId;
    public static containerId = cm.vars.buildContainerId;
}

export class Context extends events.EventEmitter {
    constructor(writers: cm.IDiagnosticWriter[]) {
        super();
        this.writers = writers;
        this.hasErrors = false;
    }

    public config: cm.IConfiguration;
    public hasErrors: boolean;
    private writers: cm.IDiagnosticWriter[];

    // TODO: parse line to direct appropriately
    public output(line: string) {
        this.writers.forEach((writer) => {
            writer.write(line);
        });
    }

    public error(message: string) {
        this.hasErrors = true;

        // in case some js task/plugins end up passing through an Error object.
        var obj = <any>message;
        if (typeof (message) === 'object' && obj.hasOwnProperty('message')) { 
            message = obj.message;
        }

        this._write(cm.DiagnosticLevel.Error, 'Error', message);
    }

    public warning(message: string) {
        this._write(cm.DiagnosticLevel.Warning, 'Warning', message);
    }

    public info(message: string) {
        this._write(cm.DiagnosticLevel.Info, null, message);
    }

    public verbose(message: string) {
        this._write(cm.DiagnosticLevel.Verbose, 'Debug', message);
    }

    public debug(message: string) {
        this._write(cm.DiagnosticLevel.Verbose, 'task.debug' , message);
    }

    private _write(level: cm.DiagnosticLevel, tag: string, message: string) {
        if (typeof (message) !== 'string') {
            trace.error('invalid message type: ' + typeof (message));
            return;
        }

        var lines = message.split(os.EOL);

        for (var i in lines) {
            var line = lines[i].replace(/(\r\n|\n|\r)/gm, '');

            var prefix = tag ? '##[' + tag + '] ' : '';
            var dateTime = new Date().toISOString() + ': ';

            var logLine = prefix + dateTime + line + os.EOL;

            var hasWritten = false;
            this.writers.forEach((writer) => {
                if (writer.level >= level) {
                    hasWritten = true;
                    if (level == cm.DiagnosticLevel.Error) {
                        writer.writeError(logLine);
                    }
                    else {
                        writer.write(logLine);
                    }
                }
            });

            if (hasWritten) {
                this.emit('message', prefix + line);    
            }
        }
    }

    public heading(message: string) {
        this.writers.forEach((writer) => {

            if (writer.level >= cm.DiagnosticLevel.Status) {
                var delim = '----------------------------------------------------------------------' + os.EOL;
                this._write(cm.DiagnosticLevel.Info, null, delim + message + delim);
            }
        });
    }

    public status(message: string) {
        this._write(cm.DiagnosticLevel.Status, null, message);
    }

    public section(message: string) {
        this.writers.forEach((writer) => {
            if (writer.level >= cm.DiagnosticLevel.Status) {
                this._write(cm.DiagnosticLevel.Info, null, ' ' + os.EOL + '+++++++' + message + ' ' + os.EOL);
            }
        });
    }

    public end(): void {
        this.writers.forEach((writer) => {
            writer.end();
        });
    }
}

export class HostContext extends Context implements cm.IHostContext {
    private _fileWriter: cm.IDiagnosticWriter;
    
    public config: cm.IConfiguration;
    public workFolder: string;
    
    constructor(config: cm.IConfiguration, fileWriter: cm.IDiagnosticWriter, consoleOutput: boolean) {
        var writers: cm.IDiagnosticWriter[] = [fileWriter];
        if (consoleOutput) {
            writers.push(new dm.DiagnosticConsoleWriter(cm.DiagnosticLevel.Status));
        }        
        super(writers);
        
        this.config = config;
        this.workFolder = cm.getWorkPath(config);
        this._fileWriter = fileWriter;        
        ensureTrace(this);     
    }
    
    public trace(message: string): void {
        this._fileWriter.write(message + os.EOL);
    }
}

export class ExecutionContext extends Context implements cm.IExecutionContext {
    constructor(jobInfo: cm.IJobInfo,
        authHandler: baseifm.IRequestHandler,
        recordId: string,
        service: cm.IServiceChannel,
        hostContext: HostContext) {

        ensureTrace(hostContext);
        trace.enter('ExecutionContext');
        
        var wd = jobInfo.variables[cm.vars.agentWorkingDirectory];
        var logFolder = path.join(wd, '_logs');

        var logData = <cm.ILogMetadata>{};
        logData.jobInfo = jobInfo;
        logData.recordId = recordId;
        var debugOutput = jobInfo.variables[cm.vars.systemDebug] == 'true'; 

        var logger: lm.PagingLogger = new lm.PagingLogger(logFolder, logData);
        logger.level =  debugOutput ? cm.DiagnosticLevel.Verbose : cm.DiagnosticLevel.Info;
        logger.on('pageComplete', (info: cm.ILogPageInfo) => {
            service.queueLogPage(info);
        });
        
        super([logger]);

        this.workingDirectory = wd;
        this.jobInfo = jobInfo;
        this.authHandler = authHandler;
        this.traceWriter = hostContext;

        this.variables = jobInfo.variables;
        this.recordId = recordId;
        this.hostContext = hostContext;
        this.service = service;
        this.config = hostContext.config;
        this.taskDefinitions = {};

        this.debugOutput = this.variables[cm.vars.systemDebug] == 'true';
        this.util = new um.Utilities(this);
        this.scmPath = path.join(__dirname, 'scm');
    }

    public traceWriter: cm.ITraceWriter;
    public debugOutput: boolean;
    public hostContext: HostContext;
    public jobInfo: cm.IJobInfo;
    public authHandler: baseifm.IRequestHandler;
    public variables: { [key: string]: string };
    public taskDefinitions: { [key: string]: agentifm.TaskDefinition };
    public recordId: string;
    public scmPath: string;
    public workingDirectory: string;
    public service: cm.IServiceChannel;
    public util: um.Utilities;
    public inputs: ifm.TaskInputs;
    public result: agentifm.TaskResult;
    public resultMessage: string;

    public processVariables() {
        trace.enter('processVariables');

        // replace variables in inputs
        var vars = this.jobInfo.jobMessage.environment.variables;
        if (vars) {
            // we don't want vars to be case sensitive
            var lowerVars = {};
            for (var varName in vars) {
                lowerVars[varName.toLowerCase()] = vars[varName];
            }

            this.jobInfo.jobMessage.tasks.forEach((task) => {
                trace.write(task.name);
                for (var key in task.inputs) {
                    if (task.inputs[key]) {
                        task.inputs[key] = task.inputs[key].replaceVars(lowerVars);    
                    }
                }
            });

            // set env vars
            for (var variable in vars) {
                var envVarName = variable.replace(".", "_").toUpperCase();
                process.env[envVarName] = vars[variable];
            }
            trace.state('variables', process.env);     
        }

        trace.state('tasks', this.jobInfo.jobMessage.tasks);
    }

    public getWebApi(): wapim.WebApi {
        return this.service.getWebApi();
    }

    public writeConsoleSection(message: string) {
        this.service.queueConsoleSection(message);
    }
    
    public trace(message: string): void {
        this.hostContext.trace(message);
    }

    public error(message: string): void {
        var obj = <any>message;
        if (typeof (message) === 'object' && obj.hasOwnProperty('message')) { 
            message = obj.message;
        }

        this.service.addError(this.recordId, "Console", message, null);
        super.error(message);
    }

    public warning(message: string): void {
        this.service.addWarning(this.recordId, "Console", message, null);
        super.warning(message);
    }
    
    public setTaskStarted(name: string): void {
        trace.enter('setTaskStarted');
        // set the job operation
        this.service.setCurrentOperation(this.jobInfo.jobId, 'Starting ' + name);

        // update the task
        this.service.setCurrentOperation(this.recordId, "Starting " + name);
        this.service.setStartTime(this.recordId, new Date());
        this.service.setState(this.recordId, agentifm.TimelineRecordState.InProgress);
        this.service.setType(this.recordId, "Task");
        this.service.setName(this.recordId, name);
    }
    
    public setTaskResult(name: string, result: agentifm.TaskResult): void {
        trace.enter('setTaskResult');
        this.service.setCurrentOperation(this.recordId, "Completed " + name);
        this.service.setState(this.recordId, agentifm.TimelineRecordState.Completed);
        this.service.setFinishTime(this.recordId, new Date());
        this.service.setResult(this.recordId, result);
        this.service.setType(this.recordId, "Task");
        this.service.setName(this.recordId, name);
    }
    
    public registerPendingTask(id: string, name: string, order: number): void {
        trace.enter('registerPendingTask');
        this.service.setCurrentOperation(id, "Initializing");
        this.service.setParentId(id, this.jobInfo.jobId);
        this.service.setName(id, name);
        this.service.setState(id, agentifm.TimelineRecordState.Pending);
        this.service.setType(id, "Task");
        this.service.setWorkerName(id, this.config.settings.agentName);
        this.service.setOrder(id, order);
    }
    
    public setJobInProgress(): void {
        trace.enter('setJobInProgress');
        
        // job
        this.service.setCurrentOperation(this.recordId, "Starting");
        this.service.setName(this.recordId, this.jobInfo.jobMessage.jobName);
        this.service.setStartTime(this.recordId, new Date());
        this.service.setState(this.recordId, agentifm.TimelineRecordState.InProgress);
        this.service.setType(this.recordId, "Job");
        this.service.setWorkerName(this.recordId, this.config.settings.agentName);
    }
    
    public finishJob(result: agentifm.TaskResult): Q.Promise<any> {
        trace.enter('finishJob');
        trace.state('result', agentifm.TaskResult[result]);

        this.setTaskResult(this.jobInfo.jobMessage.jobName, result);

        var jobRequest: agentifm.TaskAgentJobRequest = <agentifm.TaskAgentJobRequest>{};
        jobRequest.requestId = this.jobInfo.requestId;
        jobRequest.finishTime = new Date();
        jobRequest.result = result;

        trace.state('jobRequest', jobRequest);
        trace.state('this.config', this.config);

        // stop the lock renewal timer, mark the job complete and then drain so the next worker can start
        return this.service.finishJobRequest(this.config.poolId, this.jobInfo.lockToken, jobRequest).fin(() => {
            trace.write('draining feedback');
            return this.service.drain();
        });
    }
}
