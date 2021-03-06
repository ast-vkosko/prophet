
'use strict';
import { join, sep, dirname } from 'path';
import { setExtensionPath } from './providers/extensionPath'
import { workspace, ExtensionContext, commands, window, Uri, WorkspaceConfiguration, debug, WorkspaceFolder, RelativePattern } from 'vscode';
import { LanguageClient, LanguageClientOptions, ServerOptions, TransportKind } from 'vscode-languageclient';
import { CartridgesView } from './providers/CartridgesView';
import { LogsView } from './providers/LogsView';
import { ControllersView } from './providers/ControllersView';

import { existsSync, promises } from 'fs';
import { createServer, ServerResponse, IncomingMessage } from 'http';
import Uploader from "./providers/Uploader";
import { ProphetConfigurationProvider } from './providers/ConfigurationProvider';
import { Subject, Observable, of, empty } from 'rxjs';
import { map, flatMap, tap, takeUntil, filter, reduce, merge, mergeAll } from 'rxjs/operators';
import { findFiles, getDWConfig, getCartridgesFolder } from './lib/FileHelper';
import { SandboxFS } from './providers/SandboxFileSystemProvider';
import { createScriptLanguageServer, getOrderedCartridges } from './extensionScriptServer';



/**
 * Create the ISML language server with the proper parameters
 *
 * @param context the extension context
 * @param configuration the extension configuration
 */
function createIsmlLanguageServer(context: ExtensionContext, configuration: WorkspaceConfiguration = workspace.getConfiguration('extension.prophet', null)) {
	// The server is implemented in node
	const serverModule = context.asAbsolutePath(join('dist', 'ismlServer.js'));
	// The debug options for the server
	const debugOptions = { execArgv: ['--nolazy', '--inspect=6004'] };

	// If the extension is launched in debug mode then the debug server options are used
	// Otherwise the run options are used
	const serverOptions: ServerOptions = {
		run: { module: serverModule, transport: TransportKind.ipc },
		debug: { module: serverModule, transport: TransportKind.ipc, options: debugOptions }
	};
	const htmlConf = workspace.getConfiguration('html.format', null);
	// Options to control the language client
	const clientOptions: LanguageClientOptions = {
		// Register the server for plain text documents
		documentSelector: (configuration.get('ismlServer.activateOn', ['isml'])).map(type => ({
			language: type,
			scheme: 'file'
		})),
		synchronize: {
			// Synchronize the setting section 'languageServerExample' to the server
			configurationSection: 'extension.prophet',
			// Notify the server about file changes to '.clientrc files contain in the workspace
			// fileEvents: workspace.createFileSystemWatcher('**/*.isml'),
			fileEvents: workspace.createFileSystemWatcher('**/.htmlhintrc')
		},
		initializationOptions: {
			enableHtmlHint: configuration.get('htmlhint.enabled'),
			formatParams: {
				wrapLineLength: htmlConf.get('wrapLineLength'),
				unformatted: htmlConf.get('unformatted'),
				contentUnformatted: htmlConf.get('contentUnformatted'),
				indentInnerHtml: htmlConf.get('indentInnerHtml'),
				preserveNewLines: htmlConf.get('preserveNewLines'),
				maxPreserveNewLines: htmlConf.get('maxPreserveNewLines'),
				indentHandlebars: htmlConf.get('indentHandlebars'),
				endWithNewline: htmlConf.get('endWithNewline'),
				extraLiners: htmlConf.get('extraLiners'),
				wrapAttributes: htmlConf.get('wrapAttributes')
			}

		}
	};

	context.subscriptions.push(commands.registerCommand('extension.prophet.command.override.template', async (fileURI?: Uri) => {
		if (workspace.workspaceFolders && fileURI && fileURI.scheme === 'file') {
			const cartridges = await getOrderedCartridges(workspace.workspaceFolders);

			if (cartridges && cartridges.length > 1) {
				const fileSep = '/cartridge/templates/'.split('/').join(sep);
				const [, filePath] = fileURI.fsPath.split(fileSep);
				const selected = await window.showQuickPick(cartridges.map(cartridge => cartridge.name));

				if (selected) {
					const selectedCartridge = cartridges.find(cartridge => cartridge.name === selected);

					if (selectedCartridge && selectedCartridge.fsPath) {
						const newDestPath = join(selectedCartridge.fsPath, 'cartridge', 'templates', filePath);
						await promises.mkdir(dirname(newDestPath), { recursive: true });

						try {
							await promises.access(newDestPath);
						} catch (e) {
							await promises.copyFile(fileURI.fsPath, newDestPath);
						}

						await commands.executeCommand('vscode.open', Uri.file(newDestPath));
					}
				}
			}
		}
	}));

	// Create the language client and start the client.
	const ismlLanguageClient = new LanguageClient('ismlLanguageServer', 'ISML Language Server', serverOptions, clientOptions);


	//context.subscriptions.push(new SettingMonitor(ismlLanguageClient, 'extension.prophet.htmlhint.enabled').start());

	ismlLanguageClient.onReady().then(() => {
		ismlLanguageClient.onNotification('isml:selectfiles', async (test) => {
			const data: string[] | undefined = test.data;

			if (workspace.workspaceFolders && data) {
				const orderedCartridges = await getOrderedCartridges(workspace.workspaceFolders);
				const cartPath = orderedCartridges?.map(cartridge => cartridge.name).join(':');

				if (cartPath?.length) {
					const cartridges = cartPath.split(':');

					const cartridge = cartridges.find(cartridgeItem =>
						data.some(filename => filename.includes(cartridgeItem)));

					if (cartridge) {
						ismlLanguageClient.sendNotification('isml:selectedfile', data.find(
							filename => filename.includes(cartridge)
						));
						return;
					}

				}
				window.showQuickPick(test.data).then(selected => {
					ismlLanguageClient.sendNotification('isml:selectedfile', selected);
				}, err => {
					ismlLanguageClient.sendNotification('isml:selectedfile', undefined);
				});
			}

		});
		ismlLanguageClient.onNotification('find:files', ({ searchID, workspacePath, pattern }) => {
			workspace.findFiles(
				new RelativePattern(Uri.parse(workspacePath).fsPath, pattern)
			).then(result => {
				ismlLanguageClient.sendNotification('find:filesFound', { searchID, result: (result || []).map(uri => uri.fsPath) });
			})
		});
	}).catch(err => {
		window.showErrorMessage(JSON.stringify(err));
	});

	return ismlLanguageClient;
}


function getWorkspaceFolders$$(context: ExtensionContext): Observable<Observable<WorkspaceFolder>> {
	return new Observable(observer => {

		function createObservableWorkspace(workspaceFolder: WorkspaceFolder) {
			return new Observable<WorkspaceFolder>(wrkObserver => {
				const wrkListener = workspace.onDidChangeWorkspaceFolders(event => {
					try {
						event.removed && event.removed.forEach(removedWrk => {
							if (removedWrk.uri.fsPath === workspaceFolder.uri.fsPath) {
								wrkObserver.complete();
								wrkListener.dispose();
							}
						});
					} catch (e) {
						wrkObserver.error(e);
					}
				});
				wrkObserver.next(workspaceFolder)
				return () => {
					wrkListener.dispose();
				}
			});
		}

		const listener = workspace.onDidChangeWorkspaceFolders(event => {
			event.added.forEach(addWrk => {
				if (addWrk.uri.scheme === 'file') {
					observer.next(createObservableWorkspace(addWrk));
				}
			});
		});

		if (workspace.workspaceFolders) {
			workspace.workspaceFolders.forEach(addWrk => {
				if (addWrk.uri.scheme === 'file') {
					observer.next(createObservableWorkspace(addWrk));
				}
			});
		}

		context.subscriptions.push({
			dispose() {
				observer.complete();
				listener.dispose();
			}
		})
		return () => {
			listener.dispose();
		};
	});
}

export function activate(context: ExtensionContext) {
	setExtensionPath(context.extensionPath);

	context.subscriptions.push(
		commands.registerCommand('extension.prophet.command.open.documentation', () => {
			commands.executeCommand('vscode.open', Uri.parse('https://documentation.demandware.com'));
		})
	);
	context.subscriptions.push(
		commands.registerCommand('extension.prophet.command.open.xchange', () => {
			commands.executeCommand('vscode.open', Uri.parse('https://xchange.demandware.com'));
		})
	);

	// register a configuration provider
	context.subscriptions.push(
		debug.registerDebugConfigurationProvider(
			'prophet',
			new ProphetConfigurationProvider()
		)
	);


	initDebugger();

	const workspaceFolders$$ = getWorkspaceFolders$$(context);

	// const configuration = workspace.getConfiguration('extension.prophet');
	// var ismlLanguageServer = createIsmlLanguageServer(context, configuration);
	// context.subscriptions.push(ismlLanguageServer.start());

	function subscribe2disposable($: Observable<any>) {
		const subscr = $.subscribe(() => { }, err => {
			window.showErrorMessage(JSON.stringify(err));
		});

		context.subscriptions.push({
			dispose() {
				subscr.unsubscribe();
			}
		});

	}

	/// open files from browser
	subscribe2disposable(initializeToolkitActions().pipe(takeUntil(workspaceFolders$$.pipe(filter(() => false)))));

	/// uploader
	Uploader.initialize(context, workspaceFolders$$);

	// CartridgesView
	CartridgesView.initialize(context);
	ControllersView.initialize(context);

	const dwConfig$$ = workspaceFolders$$.pipe(map(workspaceFolder$ => {
		const end$ = new Subject();
		return workspaceFolder$
			.pipe(tap(() => { }, undefined, () => { end$.next(); end$.complete() }))
			.pipe(flatMap(workspaceFolder => {
				return findFiles(new RelativePattern(workspaceFolder, '**/dw.{json,js}'), 1)
			}))
			.pipe(takeUntil(end$));
	}));

	subscribe2disposable(LogsView.initialize(commands, context, dwConfig$$).pipe(mergeAll()));

	context.subscriptions.push(createIsmlLanguageServer(context).start());

	context.subscriptions.push(createScriptLanguageServer(context).start());

	const excludedMasks: { [key: string]: boolean } = workspace.getConfiguration('files', null).get<{}>('exclude') || {};

	const ignoreProjects = Object.keys(excludedMasks || {})
		.some(excludedMask => excludedMask.includes('.project') && excludedMasks && excludedMasks[excludedMask]);

	if (ignoreProjects) {
		window.showErrorMessage('Your `files.exclude` excludes `.project`. Cartridge detection may not work properly');
	}
	initFS(context);
}

function initFS(context: ExtensionContext) {

	if (!workspace.workspaceFolders) {
		return;
	}
	const fileWorkspaceFolders = workspace.workspaceFolders.filter(workspaceFolder => workspaceFolder.uri.scheme === 'file');

		const sandboxFS = new SandboxFS(getDWConfig(fileWorkspaceFolders));
		context.subscriptions.push(workspace.registerFileSystemProvider(SandboxFS.SCHEME, sandboxFS, { isCaseSensitive: true }));

		const extConf = workspace.getConfiguration('extension.prophet');
		if (extConf.get('sandbox.filesystem.enabled')) {
			if (workspace.workspaceFolders) {
				if (!workspace.workspaceFolders.some(workspaceFolder => workspaceFolder.uri.scheme.toLowerCase() === SandboxFS.SCHEME)) {
					workspace.updateWorkspaceFolders(workspace.workspaceFolders.length, 0, {
						uri: Uri.parse(SandboxFS.SCHEME + '://current-sandbox'),
						name: "Sandbox - FileSystem",
					});
				}
			}
		}
}

function initDebugger() {
	debug.onDidReceiveDebugSessionCustomEvent(event => {
		if (event.event === 'prophet.getdebugger.config' && workspace.workspaceFolders) {
			getDWConfig(workspace.workspaceFolders)
				.then(configData => {
					if (workspace.workspaceFolders) {
						const fileWorkspaceFolders = workspace.workspaceFolders.filter(workspaceFolder => workspaceFolder.uri.scheme === 'file');

						return Promise.all(fileWorkspaceFolders.map(
							workspaceFolder => getCartridgesFolder(workspaceFolder)
								.pipe(reduce<string, string[]>((acc, r) => acc.concat(r), [] as string[])).toPromise()
						)).then(projects => {

							var flatten = ([] as string[]).concat(...projects);

							if (flatten.length) {
								return event.session.customRequest('DebuggerConfig', {
									config: configData,
									cartridges: flatten
								});
							} else {
								return Promise.reject('Unable get cartridges list');
							}
						});
					} else {
						return Promise.reject('Unable detect workspaces');
					}
				}).catch(err => {
					window.showErrorMessage(JSON.stringify(err));
				});
		}
	});
}

interface IServerRequest {
	req: IncomingMessage,
	res: ServerResponse
}


function initializeToolkitActions() {
	return new Observable<IServerRequest>(observer => {
		const server = createServer((req, res) => { observer.next({ req, res }) });
		server.once('error', err => {
			if (err instanceof Error) {
				window.showWarningMessage(`Unable open port for browsers files, probably other instance or Digital Studio is opened. Error: ${err.message}`);
				server.close();
			}
			observer.error(err);
		});

		server.listen(60606);

		return () => {
			server.close();
		}
	}).pipe(flatMap(({ req, res }) => {
		if (workspace.workspaceFolders && workspace.workspaceFolders.length) {
			const fileWorkspaceFolders = workspace.workspaceFolders.filter(workspaceFolder => workspaceFolder.uri.scheme === 'file');
			const cartridgesFolders = fileWorkspaceFolders
				.map(workspaceFolder => getCartridgesFolder(workspaceFolder));

			return empty().pipe(merge(...cartridgesFolders)).pipe(reduce((acc, val) => {
				acc.add(val);
				return acc;
			}, new Set<string>()))
				.pipe(flatMap(cartridges => {
					res.writeHead(200, { 'Content-Type': 'text/plain' });
					res.end('ok');
					if (req.url && req.url.includes('/target')) {
						const reqUrl = req.url.split('/target=')[1].split('&')[0]; // fixme

						const clientFilePath = convertDebuggerPathToClient(reqUrl, Array.from(cartridges));

						if (clientFilePath) {
							const filePaths = [
								clientFilePath,
								clientFilePath.replace('.js', '.ds'),
							];

							const filePath = filePaths.find(existsSync);
							if (filePath) {
								commands.executeCommand('vscode.open', Uri.file(filePath)).then(() => {
									// DO NOTHING
								}, err => {
									window.showErrorMessage(err);
								});
							} else {
								window.showWarningMessage(`Unable to find '${reqUrl}'`);
							}
						} else {
							window.showWarningMessage(`Unable to find '${reqUrl}'.`);
						}
					}

					return of(1);
				}));
		} else {
			return empty();
		}
	}));
}

function convertDebuggerPathToClient(this: void, debuggerPath: string, cartridges: string[]): string {
	debuggerPath = debuggerPath.substr(1);
	const debuggerSep = debuggerPath.split('/');
	const cartridgeName = debuggerSep.shift() || '';

	const cartPath = cartridges.find(cartridge => cartridge.endsWith(cartridgeName));

	if (cartPath) {
		const tmp = join(cartPath, debuggerSep.join(sep));
		return tmp;
	} else {
		window.showErrorMessage("Unable match cartridge");
		return '';
	}

}

export function deactivate() {
	// nothing to do
}


