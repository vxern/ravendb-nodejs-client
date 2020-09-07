// tslint:disable-next-line:no-var-requires
// const why = require("why-is-node-running");
// setTimeout(why, 30000);

import * as fs from "fs";
import * as path from "path";
import * as url from "url";
import { MultiError, VError } from "verror";
import * as http from "http";
import * as https from "https";
import "source-map-support/register";
import { IDisposable } from "../../src/Types/Contracts";
import { RavenTestDriver } from "../TestDriver";
import { RavenServerLocator } from "../TestDriver/RavenServerLocator";
import { IDocumentStore } from "../../src/Documents/IDocumentStore";
import { getError, throwError } from "../../src/Exceptions";
import { IAuthOptions } from "../../src/Auth/AuthOptions";
import * as os from "os";
import "../../src/Utility/Polyfills";
import {
    CreateDatabaseOperation,
    DatabaseRecord,
    DeleteDatabasesOperation, DocumentConventions,
    DocumentStore, GetClusterTopologyCommand,
    IDocumentSession, ServerNode
} from "../../src";
import * as rimraf from "rimraf";
import { ChildProcess } from "child_process";
import { TypeUtil } from "../../src/Utility/TypeUtil";
import * as BluebirdPromise from "bluebird";
import { getLogger } from "../../src/Utility/LogUtil";
import { no } from "change-case";
import { AdminJsConsoleOperation } from "./AdminJsConsoleOperation";

const log = getLogger({ module: "TestDriver" });

// logOnUncaughtAndUnhandled();

function logOnUncaughtAndUnhandled() {
    process.on("unhandledRejection", (...args) => {
        // tslint:disable-next-line:no-console
        console.log(...args);
    });

    process.on("uncaughtException", (...args) => {
        // tslint:disable-next-line:no-console
        console.log(...args);
    });
}

class TestServiceLocator extends RavenServerLocator {
    public getCommandArguments() {
        const cliOpts = [
            "--ServerUrl=http://127.0.0.1:0", 
            "--ServerUrl.Tcp=tcp://127.0.0.1:38884",
            "--Features.Availability=Experimental"
        ];

        return cliOpts;
    }
}

class TestSecuredServiceLocator extends RavenServerLocator {
    public static ENV_SERVER_CA_PATH = "RAVENDB_TEST_CA_PATH";

    public static ENV_SERVER_CERTIFICATE_PATH = "RAVENDB_TEST_SERVER_CERTIFICATE_PATH";
    public static ENV_HTTPS_SERVER_URL = "RAVENDB_TEST_HTTPS_SERVER_URL";

    public static ENV_CLIENT_CERT_PATH = "RAVENDB_TEST_CLIENT_CERT_PATH";
    public static ENV_CLIENT_CERT_PASSPHRASE = "RAVENDB_TEST_CLIENT_CERT_PASSPHRASE";

    public getCommandArguments() {
        const certPath = this.getServerCertificatePath();
        if (!certPath) {
            throwError("InvalidOperationException", "Unable to find RavenDB server certificate path. " +
                "Please make sure " + TestSecuredServiceLocator.ENV_SERVER_CERTIFICATE_PATH
                + " environment variable is set and valid " + "(current value = " + certPath + ")");
        }

        return [
            "--Security.Certificate.Path=" + certPath,
            "--ServerUrl=" + this._getHttpsServerUrl(),
            "--ServerUrl.Tcp=" + this._getHttpsServerTcpUrl(),
            "--Features.Availability=Experimental"
        ];
    }

    private _getHttpsServerUrl() {
        const httpsServerUrl = process.env[TestSecuredServiceLocator.ENV_HTTPS_SERVER_URL];
        if (!httpsServerUrl) {
            throwError("InvalidArgumentException",
                "Unable to find RavenDB https server url. " +
                "Please make sure " + TestSecuredServiceLocator.ENV_HTTPS_SERVER_URL
                + " environment variable is set and is valid " +
                "(current value = " + httpsServerUrl + ")");
        }

        return httpsServerUrl;
    }

    private _getHttpsServerTcpUrl() {
        const https = this._getHttpsServerUrl();
        return "tcp://" + url.parse(https).hostname + ":38882";
    }

    public getServerCertificatePath() {
        return path.resolve(process.env[TestSecuredServiceLocator.ENV_SERVER_CERTIFICATE_PATH]);
    }

    public getClientAuthOptions(): IAuthOptions {
        const clientCertPath = process.env[TestSecuredServiceLocator.ENV_CLIENT_CERT_PATH];
        const clientCertPass = process.env[TestSecuredServiceLocator.ENV_CLIENT_CERT_PASSPHRASE];

        const serverCaCertPath = process.env[TestSecuredServiceLocator.ENV_SERVER_CA_PATH];

        if (!clientCertPath) {
            return {
                certificate: fs.readFileSync(this.getServerCertificatePath()),
                type: "pfx"
            };
        }

        return {
            type: "pem",
            certificate: fs.readFileSync(clientCertPath, "utf-8"),
            password: clientCertPass,
            ca: fs.readFileSync(serverCaCertPath, "utf-8"),
        };
    }
}

export class RavenTestContext extends RavenTestDriver implements IDisposable {

    public static isRunningOnWindows = os.platform() === "win32";

    public static isPullRequest = !process.env["RAVEN_License"];

    public static is41 = process.env["RAVENDB_SERVER_VERSION"] === "4.1";

    private readonly _locator: RavenServerLocator;
    private readonly _securedLocator: RavenServerLocator;

    private static _globalServer: IDocumentStore;
    private static _globalServerProcess: ChildProcess;

    private static _globalSecuredServer: IDocumentStore;
    private static _globalSecuredServerProcess: ChildProcess;

    private _documentStores: Set<IDocumentStore> = new Set();

    private static _index: number = 0;

    public constructor() {
        super();
        this._locator = new TestServiceLocator();
        this._securedLocator = new TestSecuredServiceLocator();
    }

    private _customizeDbRecord: (dbRecord: DatabaseRecord) => void = TypeUtil.NOOP;
    private _customizeStore: (store: DocumentStore) => Promise<void> = TypeUtil.ASYNC_NOOP;

    public set customizeDbRecord(customizeDbRecord: (dbRecord: DatabaseRecord) => void) {
        this._customizeDbRecord = customizeDbRecord;
    }

    public get customizeDbRecord() {
        return this._customizeDbRecord;
    }

    public set customizeStore(customizeStore: (store: DocumentStore) => Promise<void>) {
        this._customizeStore = customizeStore;
    }

    public get customizeStore() {
        return this._customizeStore;
    }

    public getSecuredDocumentStore(): Promise<DocumentStore>;
    public getSecuredDocumentStore(database?): Promise<DocumentStore> {
        return this.getDocumentStore(database, true, null);
    }

    private async _runServer(secured: boolean) {
        let childProcess: ChildProcess;

        const store = await this._runServerInternal(this._getLocator(secured), p => childProcess = p, s => {
            if (secured) {
                s.authOptions = this._securedLocator.getClientAuthOptions();
            }
        });

        RavenTestContext._setGlobalServerProcess(secured, childProcess);

        if (secured) {
            RavenTestContext._globalSecuredServer = store;
        } else {
            RavenTestContext._globalServer = store;
        }

        return store;
    }

    private _getLocator(secured: boolean) {
        return secured ? this._securedLocator : this._locator;
    }

    private static _getGlobalServer(secured: boolean) {
        return secured ? this._globalSecuredServer : this._globalServer;
    }

    private static _getGlobalProcess(secured: boolean) {
        return secured ? this._globalSecuredServerProcess : this._globalServerProcess;
    }

    private static _setGlobalServerProcess(secured: boolean, p: ChildProcess) {
        if (secured) {
            this._globalSecuredServerProcess = p;
        } else {
            this._globalServerProcess = p;
        }
    }


    private static _killGlobalServerProcess(secured: boolean): void {
        let p: ChildProcess;
        let store;
        if (secured) {
            p = this._globalSecuredServerProcess;
            this._globalSecuredServerProcess = null;
            if (this._globalSecuredServer) {
                this._globalSecuredServer.dispose();
                this._globalSecuredServer = null;
            }
        } else {
            p = this._globalServerProcess;
            this._globalServerProcess = null;
            if (this._globalServer) {
                this._globalServer.dispose();
                this._globalServer = null;
            }
        }

        new BluebirdPromise(resolve => {
            if (store) {
                store.on("executorsDisposed", () => resolve());
            } else {
                resolve();
            }
        })
            .timeout(2000)
            .finally(() => {
                this._killProcess(p);
            });

        if (store) {
            store.dispose();
        }
    }

    public getDocumentStore(): Promise<DocumentStore>;
    public getDocumentStore(database: string): Promise<DocumentStore>;
    public getDocumentStore(database: string, secured: boolean): Promise<DocumentStore>;
    public getDocumentStore(
        database: string, secured: boolean, waitForIndexingTimeoutInMs?: number): Promise<DocumentStore>;
    public getDocumentStore(
        database = "test_db", secured = false, waitForIndexingTimeoutInMs: number = null): Promise<DocumentStore> {

        const databaseName = database + "_" + (++RavenTestContext._index);
        log.info(`getDocumentStore for db ${ database }.`);

        let documentStore: IDocumentStore;
        return Promise.resolve()
            .then(() => {
                if (!RavenTestContext._getGlobalServer(secured)) {
                    return this._runServer(secured);
                }
            })
            .then(() => {
                documentStore = RavenTestContext._getGlobalServer(secured);
                const databaseRecord: DatabaseRecord = { databaseName };

                if (this._customizeDbRecord) {
                    this._customizeDbRecord(databaseRecord);
                }

                const createDatabaseOperation = new CreateDatabaseOperation(databaseRecord);
                return documentStore.maintenance.server.send(createDatabaseOperation);
            })
            .then(async createDatabaseResult => {
                const store = new DocumentStore(documentStore.urls, databaseName);
                if (secured) {
                    store.authOptions = this._securedLocator.getClientAuthOptions();
                }

                if (this._customizeStore) {
                    await this._customizeStore(store);
                }

                store.initialize();

                (store as IDocumentStore)
                    .once("afterDispose", (callback) => {
                        if (!this._documentStores.has(store)) {
                            callback();
                            return;
                        }

                        BluebirdPromise.resolve()
                            .then(() => {
                                return store.maintenance.server.send(new DeleteDatabasesOperation({
                                    databaseNames: [store.database],
                                    hardDelete: true
                                }));
                            })
                            .tap((deleteResult) => {
                                log.info(`Database ${store.database} deleted.`);
                            })
                            .catch(err => {
                                if (err.name === "DatabaseDoesNotExistException"
                                    || err.name === "NoLeaderException") {
                                    return;
                                }

                                if (store.isDisposed() || !RavenTestContext._getGlobalProcess(secured)) {
                                    return;
                                }

                                throwError("TestDriverTearDownError",
                                    `Error deleting database ${ store.database }.`, err);
                            })
                            .finally(() => callback());
                    });

                return Promise.resolve()
                    .then(() => this._setupDatabase(store))
                    .then(() => {
                        if (!TypeUtil.isNullOrUndefined(waitForIndexingTimeoutInMs)) {
                            return this.waitForIndexing(store);
                        }
                    })
                    .then(() => this._documentStores.add(store))
                    .then(() => store);

            });
    }

    public static setupServer(): RavenTestContext {
        return new RavenTestContext();
    }

    public dispose(): void {
        log.info("Dispose.");

        if (this._disposed) {
            return;
        }

        this._disposed = true;

        const STORE_DISPOSAL_TIMEOUT = 10000;
        const storeDisposalPromises = [...this._documentStores].map((store) => {
            return Promise.resolve()
                .then(() => {
                    const result = new BluebirdPromise((resolve) => {
                        store.once("executorsDisposed", () => {
                            resolve();
                        });
                    })
                        .timeout(STORE_DISPOSAL_TIMEOUT)
                        .then(() => null);

                    store.dispose();
                    return result;
                })
                .catch((err: Error) =>
                    getError("TestDriverTeardownError", "Error disposing document store", err));
        });

        BluebirdPromise.all(storeDisposalPromises)
            .then((errors) => {
                const anyErrors = errors.filter(x => !!x);
                if (anyErrors.length) {
                    throw new MultiError(anyErrors);
                }
            })
            .then(() => {
                if (RavenTestContext._globalSecuredServer) {
                    RavenTestContext._globalSecuredServer.dispose();
                }

                if (RavenTestContext._globalServer) {
                    RavenTestContext._globalServer.dispose();
                }
            })
            .finally(() => {
                RavenTestContext._killGlobalServerProcess(true);
                RavenTestContext._killGlobalServerProcess(false);
            });
    }
}

class TestCloudServiceLocator extends RavenServerLocator {
    getCommandArguments(): string[] {
        return [
            "--ServerUrl=http://127.0.0.1:0",
            "--Features.Availability=Experimental"
        ]
    }
}

export class ClusterTestContext extends RavenTestDriver {
    private _dbCounter = 1;

    public getDatabaseName(): string {
        return "db_" + (++this._dbCounter);
    }

    private locator = new TestCloudServiceLocator();

    public async createRaftCluster(numberOfNodes: number) {
        const cluster = new ClusterController();
        cluster.nodes = [];

        const allowedNodeTags = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M", "N", "O", "P", "Q", "R", "S", "T", "U", "V", "W", "X", "Y", "Z"];

        let leaderIndex = 0;
        const leaderNodeTag = allowedNodeTags[leaderIndex];

        for (let i = 0 ; i < numberOfNodes; i++) {
            let process: ChildProcess;
            const store = await this._runServerInternal(this.locator, p => process = p, null);

            //TODO: +            Runtime.getRuntime().addShutdownHook(new Thread(() -> killProcess(processReference.value)));

            const clusterNode = new ClusterNode();
            clusterNode.serverProcess = process;
            clusterNode.store = store;
            clusterNode.url = store.urls[0];
            clusterNode.nodeTag = allowedNodeTags[i];
            clusterNode.leader = i === leaderIndex;

            cluster.nodes.push(clusterNode);
        }

        await cluster.executeJsScript(leaderNodeTag, "server.ServerStore.EnsureNotPassive(null, \"" + leaderNodeTag + "\");");

        if (numberOfNodes > 1) {
            // add nodes to cluster
            for (let i = 0; i < numberOfNodes; i++) {
                if (i === leaderIndex) {
                    continue;
                }

                const nodeTag = allowedNodeTags[i];
                const url = cluster.nodes[i].url;

                await cluster.executeJsScript(leaderNodeTag, "server.ServerStore.ValidateFixedPort = false;" +
                    "server.ServerStore.AddNodeToClusterAsync(\"" + url + "\", \"" + nodeTag + "\", false, false, server.ServerStore.ServerShutdown).Wait();");

                await cluster.executeJsScript(nodeTag, "server.ServerStore.WaitForTopology(0, server.ServerStore.ServerShutdown).Wait();");
            }
        }

        return cluster;
    }
}

class ClusterController implements IDisposable {
    public nodes: ClusterNode[];

    public async executeJsScript(nodeTag: string, script: string) {
        const targetNode = this.getNodeByTag(nodeTag);

        const store = new DocumentStore(targetNode.url, null);
        try {
            store.conventions.disableTopologyUpdates = true;
            store.initialize();

            return await store.maintenance.server.send(new AdminJsConsoleOperation(script));
        } finally {
            store.dispose();
        }
    }

    public async executeJsScriptRaw(nodeTag: string, script: string) {
        const targetNode = this.getNodeByTag(nodeTag);

        const jsConsole = new AdminJsConsoleOperation(script);
        const command = jsConsole.getCommand(new DocumentConventions());

        const serverNode = new ServerNode({
            url: targetNode.url
        });

        const request = command.createRequest(serverNode);

        const store = new DocumentStore(targetNode.url, "_");
        try {
            store.initialize();

            const httpAgent = store.getRequestExecutor().getHttpAgent();
            const response = await command.send(httpAgent, request);

            /* TODO
             if (response.getEntity() != null) {
+                    return store.getConventions().getEntityMapper().readTree(response.getEntity().getContent());
+                }
             */

            return null;
        } finally {
            store.dispose();
        }
    }

    public getNodeByTag(nodeTag: string) {
        const node = this.nodes.find(x => x.nodeTag === nodeTag);

        if (!node) {
            throwError("InvalidArgumentException", "Unable to find node with tag: " + nodeTag);
        }

        return node;
    }

    public async getCurrentLeader(store: IDocumentStore) {
        const command = new GetClusterTopologyCommand();
        await store.getRequestExecutor().execute(command);

        return command.result.leader;
    }

    public async disposeServer(nodeTag: string) {
        try {
            await this.executeJsScriptRaw(nodeTag, "server.Dispose()");
        } catch {
            // we likely throw as server won't be able to respond
        }
    }

    public getInitialLeader() {
        return this.nodes.find(x => x.leader);
    }

    public async createDatabase(databaseRecord: DatabaseRecord, replicationFactor: number, leaderUrl: string) {
        const store = new DocumentStore(leaderUrl, databaseRecord.databaseName);

        try {
            store.initialize();

            const putResult = await store.maintenance.server.send(new CreateDatabaseOperation(databaseRecord, replicationFactor));

            for (const node of this.nodes) {
                await this.executeJsScript(node.nodeTag, "server.ServerStore.Cluster.WaitForIndexNotification(\"" + putResult.raftCommandIndex + "\").Wait()");
            }
        } finally {
            store.dispose();
        }
    }

    public dispose() {
        for (const node of this.nodes) {
            try {
                node.serverProcess.kill("SIGKILL");
            } catch {
                // ignore
            }
        }
    }
}

class ClusterNode {
    public nodeTag: string;
    public url: string;
    public leader: boolean;
    public store: IDocumentStore;
    public serverProcess: ChildProcess;
}

export async function disposeTestDocumentStore(store: IDocumentStore) {
    if (!store) {
        return;
    }

    return new Promise<void>(resolve => {
        if (store) {
            store.once("executorsDisposed", () => resolve());
            store.dispose();
        }
    });
}

export let testContext: RavenTestContext;
setupRavenDbTestContext();

export let clusterTestContext: ClusterTestContext;

// tslint:disable:no-console
function checkAgent(agentName: string, agent: http.Agent) {
    const reqKeys = Object.keys(agent.requests);
    if (reqKeys.length) {
        console.log(`${agentName} dangling requests: ${reqKeys}`);
    }

    const sockKeys = Object.keys(agent.sockets);
    if (sockKeys.length) {
        console.log(`${agentName} dangling sockets: ${sockKeys}`);
    }
}

function setupRavenDbTestContext() {

    before(() => {
        testContext = RavenTestContext.setupServer();
    });

    afterEach(function () {
        if (this.currentTest && this.currentTest.state === "failed") {
            console.error(VError.fullStack(this.currentTest.err));
        }
    });

    after(() => {
        testContext.dispose();

        process.on("beforeExit", () => {
            checkAgent("http", http.globalAgent);
            checkAgent("https", https.globalAgent);
        });
    });

    return testContext;
}
// tslint:enable:no-console

export async function storeNewDoc(
    session: IDocumentSession, data: object, id: string, clazz: any) {
    const order = Object.assign(new clazz(), data);
    await session.store(order, id);
    return order;
}


export class TemporaryDirContext implements IDisposable {

    public tempDir: string;

    constructor() {
        this.tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rdb-node-"));
    }

    dispose(): void {
        rimraf.sync(this.tempDir);
    }
}