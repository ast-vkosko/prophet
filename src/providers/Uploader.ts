import { Observable, Subscription, Subject, of, from } from 'rxjs';
import { window, OutputChannel, ExtensionContext, workspace, commands, WorkspaceFolder } from 'vscode';
import * as uploadServer from "../server/uploadServer";
import { getCartridgesFolder, getDWConfig } from '../lib/FileHelper';
import { basename } from 'path';
import { flatMap, reduce } from 'rxjs/operators';

const commandBus = new Subject<'enable.upload' | 'clean.upload' | 'disable.upload'>();

const diff = function (a: string[], b: string[]) {
	return b.filter(function (i) { return a.indexOf(i) < 0; });
};

let firstClean = true;
let removeFilesMode: undefined | 'remove' | 'leave';
/**
 * Class for handling the server upload integration
 */
export default class Uploader {
	private outputChannel: OutputChannel;
	//private configuration;
	private prevState;
	private uploaderSubscription: Subscription | null = null;
	private get cleanOnStart(): boolean {
		if (firstClean) {
			firstClean = false;
			return Boolean(workspace.getConfiguration('extension.prophet').get('clean.on.start'));
		} else {
			return true;
		}
	};
	private commandSubs: Subscription;
	private workspaceFolders: WorkspaceFolder[];

	/**
	 *
	 * @param configuration the workspace configuration to use
	 */
	constructor(workspaceFolders: readonly WorkspaceFolder[]) {
		this.outputChannel = window.createOutputChannel(`Prophet Uploader`);
		this.workspaceFolders = workspaceFolders.filter(workspaceFolder => workspaceFolder.uri.scheme === 'file');

		this.commandSubs = commandBus.subscribe(command => {
			if (command === 'clean.upload' || command === 'enable.upload') {
				this.loadUploaderConfig();
			} else if (command === 'disable.upload') {
				if (this.uploaderSubscription) {
					this.outputChannel.appendLine(`Stopping`);
					this.uploaderSubscription!.unsubscribe();
					this.uploaderSubscription = null;
				}
			}
		});
	}

	/**
	 * Returns the enabled status from the configuration
	 */
	isUploadEnabled() {
		return !!workspace.getConfiguration('extension.prophet').get('upload.enabled');
	}
	getIgnoreList(): string[] {
		return workspace.getConfiguration('extension.prophet').get('ignore.list', ['node_modules', '\\.git', '\\.zip$']);
	}

	async askCleanCartridge(fileNamesOnSandbox: string[], cartridgesToUpload: string[]): Promise<string[]> {
		const cartridgesNamesToUpload = cartridgesToUpload.map(cartridge => basename(cartridge));
		const extraOnSB = diff(cartridgesNamesToUpload, fileNamesOnSandbox).filter(name => {
			return !name.endsWith('.zip');
		});

		if (extraOnSB.length === 0) {
			return [];
		} else if (removeFilesMode) {
			if (removeFilesMode === 'remove') {
				return fileNamesOnSandbox;
			} else {
				return [];
			}
		} else {
			// Grab the configuration from the dw.{json,js} file
			const config = await getDWConfig(this.workspaceFolders);

			if (config.cartridgeResolution === 'remove') {
				removeFilesMode = "remove";
				return fileNamesOnSandbox;
			} else if (config.cartridgeResolution === 'leave') {
				removeFilesMode = "leave";
				return [];
			}

			// Prompt the user for his preferred action
			const response = await window.showWarningMessage(`Your sandbox has extra cartridge/s. "${extraOnSB.join('", "')}". What would you like to do?`,
				'Remove All Always', 'Leave All Always', 'Remove All', 'Leave All');

			if (response) {

				switch (response) {
					case 'Remove All Always':
						removeFilesMode = "remove";
						return fileNamesOnSandbox;
					case 'Leave All Always':
						removeFilesMode = "leave";
						return [];
					case 'Remove All':
						return fileNamesOnSandbox;
					default:
						return [];
				}
			} else {
				return [];
			}
		}
	}

	/**
	 * Remove cartridges before upload which are twice in the workspace, to avoid race conditions due to concurrent uploads
	 */
	removeDuplicateCartridges(cartridgesToUpload: string[]): string[] {
		let uniqueCartridges = Array<String>();
		let duplicateCartridges = Array<String>();
		cartridgesToUpload = cartridgesToUpload.filter((cartridge) => {
			let cartridgeName = basename(cartridge);
			if (!uniqueCartridges.includes(cartridgeName)) {
				uniqueCartridges.push(cartridgeName);
				return true;
			}
			duplicateCartridges.push(cartridge);
			return false;
		});

		if (duplicateCartridges.length === 0) {
			return cartridgesToUpload;
		}

		window.showWarningMessage(
			`Following cartridge/s are duplicates and won't be uploaded. "${duplicateCartridges.join('", "')}".`,
			'Ok');
		return cartridgesToUpload;
	}

	/**
	 * Loads the uploader configuration and start the server
	 */
	loadUploaderConfig() {
		if (this.uploaderSubscription) {
			this.uploaderSubscription.unsubscribe();
			this.uploaderSubscription = null;
			this.outputChannel.appendLine(`Restarting`);
		} else {
			this.outputChannel.appendLine(`Starting...`);
		}


		this.uploaderSubscription = from(getDWConfig(workspace.workspaceFolders))
			.pipe(flatMap(dwConf => {
				this.outputChannel.appendLine(`Using config file '${dwConf.configFilename}'`);

				return of(...this.workspaceFolders)
					.pipe(flatMap(workspaceFolder => getCartridgesFolder(workspaceFolder)))
					.pipe(reduce((acc, val) => {
						acc.add(val);
						return acc;
					}, new Set<string>()))
					.pipe(flatMap(cartridges => {
						if (Array.isArray(dwConf.cartridge) && dwConf.cartridge.length) {
							const filteredCartridges = Array.from(cartridges)
								.filter(cartridge => dwConf.cartridge && dwConf.cartridge.some(
									dwCar => basename(cartridge) === dwCar)
								);

							if (filteredCartridges.length !== dwConf.cartridge.length) {
								const missedCartridges = dwConf.cartridge
									.filter(dwCar => dwConf.cartridge && !filteredCartridges.some(cartridge => basename(cartridge) === dwCar)
									);

								window.showWarningMessage(`Cartridge${missedCartridges.length > 1 ? 's' : ''} "${missedCartridges.join('", "')}" does not exist on file system (or not determined as cartridge/s) while added in configuration. It will be ignored, please restart the uploader once this has been resolved.`);
							}
							dwConf.cartridge = filteredCartridges;
						} else {
							dwConf.cartridge = Array.from(cartridges)
						}

						dwConf.cartridge = this.removeDuplicateCartridges(dwConf.cartridge);

						return uploadServer.init(
							dwConf,
							this.outputChannel,
							{ cleanOnStart: this.cleanOnStart, ignoreList: this.getIgnoreList() },
							this.askCleanCartridge.bind(this)
						);
					}))
			}))
			.subscribe(
				() => {
					// DO NOTHING
				},
				err => {
					this.outputChannel.show();
					this.outputChannel.appendLine(`Error: ${err}`);
					if (err instanceof Error) {
						this.outputChannel.appendLine(`Error: ${err.stack}`);
					}
				},
				() => {
					this.outputChannel.show();
					this.outputChannel.appendLine(`Error: completed!`);
				}
			);
	}
	static initialize(context: ExtensionContext, workspaceFolder$$: Observable<Observable<WorkspaceFolder>>) {
		var subscriptions = context.subscriptions;

		subscriptions.push(commands.registerCommand('extension.prophet.command.enable.upload', () => {
			commandBus.next('enable.upload');
		}));

		subscriptions.push(commands.registerCommand('extension.prophet.command.clean.upload', () => {
			commandBus.next('clean.upload');
		}));

		subscriptions.push(commands.registerCommand('extension.prophet.command.disable.upload', () => {
			commandBus.next('disable.upload');
		}));

		let subs: Subscription | undefined;

		const updateFolders = () => {
			if (subs) {
				subs.unsubscribe();
				subs = undefined;
			}

			if (workspace.workspaceFolders) {
				const uploader = new Uploader(workspace.workspaceFolders);
				subs = uploader.start().subscribe();
			}
		};

		workspace.onDidChangeWorkspaceFolders(updateFolders);

		updateFolders();

		// const configuration = workspace.getConfiguration('extension.prophet', workspaceFolder.uri);
		// const uploader = new Uploader(configuration, workspaceFolder);
		// return uploader.start();
		subscriptions.push({
			dispose: () => {
				commandBus.unsubscribe();
				if (subs) {
					subs.unsubscribe();
				}
			}
		})
	}

	/**
	 * Registers commands, creates listeners and starts the uploader
	 *
	 */
	start() {
		return new Observable<string>(observer => {
			const configSubscription = workspace.onDidChangeConfiguration(() => {
				const isProphetUploadEnabled = this.isUploadEnabled();

				if (isProphetUploadEnabled !== this.prevState) {
					this.prevState = isProphetUploadEnabled;
					if (isProphetUploadEnabled) {
						this.loadUploaderConfig();
					} else {
						if (this.uploaderSubscription) {
							this.outputChannel.appendLine(`Stopping`);
							this.uploaderSubscription.unsubscribe();
							this.uploaderSubscription = null;
						}
					}
				}
			});


			const isUploadEnabled = this.isUploadEnabled();
			this.prevState = isUploadEnabled;
			if (isUploadEnabled) {
				this.loadUploaderConfig();
			} else {
				this.outputChannel.appendLine('Uploader disabled via configuration');
			}
			observer.next();
			return () => {
				this.outputChannel.appendLine('Shutting down...');
				configSubscription.dispose();
				this.commandSubs.unsubscribe();

				if (this.uploaderSubscription) {
					this.uploaderSubscription.unsubscribe();
				}
				this.outputChannel.dispose();
			}
		}
		);

	}
}

