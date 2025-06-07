import { App, Plugin, PluginSettingTab, Setting, MarkdownView, TAbstractFile } from 'obsidian';

interface PluginSettings {
	dbFileName: string;
	delayAfterFileOpening: number;
	saveTimer: number;
}

const SAFE_DB_FLUSH_INTERVAL = 5000;

const DEFAULT_SETTINGS: PluginSettings = {
	dbFileName: '.obsidian/plugins/remember-scroll-position/scroll-positions.json',
	delayAfterFileOpening: 100,
	saveTimer: SAFE_DB_FLUSH_INTERVAL,
};

interface EphemeralState {
	scroll?: number
}


export default class RememberScrollPosition extends Plugin {
	settings: PluginSettings;
	db: { [file_path: string]: EphemeralState };
	lastSavedDb: { [file_path: string]: EphemeralState };
	lastEphemeralState: EphemeralState;
	lastLoadedFileName: string;
	loadedLeafIdList: string[] = [];
	loadingFile = false;
	scrollThrottleTimer: number | null = null;

	async onload() {
		await this.loadSettings();

		try {
			this.db = await this.readDb();
			this.lastSavedDb = await this.readDb();
		} catch (e) {
			console.error(
				"Remember Scroll Position plugin can\'t read database: " + e
			);
			this.db = {};
			this.lastSavedDb = {};
		}

		this.addSettingTab(new SettingTab(this.app, this));

		this.registerEvent(
			this.app.workspace.on('file-open', () => this.restoreEphemeralState())
		);
		

		this.registerEvent(
			this.app.workspace.on('quit', () => { this.writeDb(this.db) }),
		);


		this.registerEvent(
			this.app.vault.on('rename', (file, oldPath) => this.renameFile(file, oldPath)),
		);

		this.registerEvent(
			this.app.vault.on('delete', (file) => this.deleteFile(file)),
		);

		// Set up event-driven scroll detection
		this.setupScrollEventListeners();

		this.registerInterval(
			window.setInterval(() => this.writeDb(this.db), this.settings.saveTimer)
		);

		this.restoreEphemeralState();
	}

	onunload() {
		// Clean up any pending throttle timer
		if (this.scrollThrottleTimer) {
			clearTimeout(this.scrollThrottleTimer);
			this.scrollThrottleTimer = null;
		}
	}

	setupScrollEventListeners() {
		// Listen for scroll events on the workspace container
		this.registerDomEvent(
			this.app.workspace.containerEl,
			'scroll',
			this.onScrollEvent.bind(this),
			{ passive: true, capture: true }
		);

		// Listen for mouse wheel events (for smooth scrolling)
		this.registerDomEvent(
			this.app.workspace.containerEl,
			'wheel',
			this.onScrollEvent.bind(this),
			{ passive: true }
		);

		// Listen for keyboard events that might cause scrolling
		this.registerDomEvent(
			this.app.workspace.containerEl,
			'keydown',
			this.onKeyboardEvent.bind(this)
		);
	}

	onScrollEvent() {
		// Throttle scroll events to avoid excessive processing
		if (this.scrollThrottleTimer) {
			clearTimeout(this.scrollThrottleTimer);
		}

		this.scrollThrottleTimer = window.setTimeout(() => {
			this.checkEphemeralStateChanged();
			this.scrollThrottleTimer = null;
		}, 50); // 50ms throttle - much better than 100ms polling
	}

	onKeyboardEvent(event: KeyboardEvent) {
		// Only respond to keys that typically cause scrolling
		const scrollKeys = ['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', 'Space'];
		if (scrollKeys.includes(event.key)) {
			// Small delay to let the scroll happen first
			setTimeout(() => this.onScrollEvent(), 10);
		}
	}

	renameFile(file: TAbstractFile, oldPath: string) {
		let newName = file.path;
		let oldName = oldPath;
		this.db[newName] = this.db[oldName];
		delete this.db[oldName];
	}


	deleteFile(file: TAbstractFile) {
		let fileName = file.path;
		delete this.db[fileName];
	}


	checkEphemeralStateChanged() {
		let fileName = this.app.workspace.getActiveFile()?.path;

		//waiting for load new file
		if (!fileName || !this.lastLoadedFileName || fileName != this.lastLoadedFileName || this.loadingFile)
			return;

		let st = this.getEphemeralState();

		if (!this.lastEphemeralState)
			this.lastEphemeralState = st;

		if (!isNaN(st.scroll) && !this.isEphemeralStatesEquals(st, this.lastEphemeralState)) {
			this.saveEphemeralState(st);
			this.lastEphemeralState = st;
		}
	}

	isEphemeralStatesEquals(state1: EphemeralState, state2: EphemeralState): boolean {
		if (state1.scroll && !state2.scroll)
			return false;

		if (!state1.scroll && state2.scroll)
			return false;

		if (state1.scroll && state1.scroll != state2.scroll)
			return false;

		return true;
	}


	async saveEphemeralState(st: EphemeralState) {
		let fileName = this.app.workspace.getActiveFile()?.path;
		if (fileName && fileName == this.lastLoadedFileName) { //do not save if file changed or was not loaded
			this.db[fileName] = st;
		}
	}


	async restoreEphemeralState() {
		let fileName = this.app.workspace.getActiveFile()?.path;

		if (fileName && this.loadingFile && this.lastLoadedFileName == fileName) //if already started loading
			return;

		let activeLeaf = this.app.workspace.getMostRecentLeaf()
		if (activeLeaf && this.loadedLeafIdList.includes((activeLeaf as any).id + ':' + activeLeaf.getViewState().state.file))
			return;

		this.loadedLeafIdList = []
		this.app.workspace.iterateAllLeaves((leaf) => {
			if (leaf.getViewState().type ==="markdown") {
				this.loadedLeafIdList.push((leaf as any).id + ':' +  leaf.getViewState().state.file)
			}
		});
		
		this.loadingFile = true;

		if (this.lastLoadedFileName != fileName) {
			this.lastEphemeralState = {}
			this.lastLoadedFileName = fileName;
			
			let st:EphemeralState

			if (fileName) {
				st = this.db[fileName];
				if (st) {
					//waiting for load note
					await this.delay(this.settings.delayAfterFileOpening)

					// Don't scroll when a link scrolls and highlights text
					// i.e. if file is open by links like [link](note.md#header) and wikilinks
					// See #10, #32, #46, #51
					let containsFlashingSpan = this.app.workspace.containerEl.querySelector('span.is-flashing');

					if (!containsFlashingSpan) {
						await this.delay(10)
						this.setEphemeralState(st);
					}
				}
			} 
			this.lastEphemeralState = st;
		}

		this.loadingFile = false;
	}

	async readDb(): Promise<{ [file_path: string]: EphemeralState; }> {
		let db: { [file_path: string]: EphemeralState; } = {}

		if (await this.app.vault.adapter.exists(this.settings.dbFileName)) {
			let data = await this.app.vault.adapter.read(this.settings.dbFileName);
			db = JSON.parse(data);
		}

		return db;
	}

	async writeDb(db: { [file_path: string]: EphemeralState; }) {
		//create folder for db file if not exist
		let newParentFolder = this.settings.dbFileName.substring(0, this.settings.dbFileName.lastIndexOf("/"));
		if (!(await this.app.vault.adapter.exists(newParentFolder)))
			this.app.vault.adapter.mkdir(newParentFolder);

		if (JSON.stringify(this.db) !== JSON.stringify(this.lastSavedDb)) {
			this.app.vault.adapter.write(
				this.settings.dbFileName,
				JSON.stringify(db)
			);
			this.lastSavedDb = JSON.parse(JSON.stringify(db));
		}
	}



	getEphemeralState(): EphemeralState {
		let state: EphemeralState = {};
		state.scroll = Number(this.app.workspace.getActiveViewOfType(MarkdownView)?.currentMode?.getScroll()?.toFixed(4));
		return state;
	}

	setEphemeralState(state: EphemeralState) {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (view && state.scroll) {
			view.setEphemeralState(state);
		}
	}



	async loadSettings() {
		let settings: PluginSettings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData()
		);
		if (settings?.saveTimer < SAFE_DB_FLUSH_INTERVAL) {
			settings.saveTimer = SAFE_DB_FLUSH_INTERVAL;
		}
		this.settings = settings;
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	async delay(ms: number) {
		return new Promise(resolve => setTimeout(resolve, ms));
	}
}



class SettingTab extends PluginSettingTab {
	plugin: RememberScrollPosition;

	constructor(app: App, plugin: RememberScrollPosition) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		let { containerEl } = this;

		containerEl.empty();

		containerEl.createEl('h2', { text: 'Remember Scroll Position - Settings' });

		new Setting(containerEl)
			.setName('Data file name')
			.setDesc('Save positions to this file')
			.addText((text) =>
				text
					.setPlaceholder('Example: scroll-positions.json')
					.setValue(this.plugin.settings.dbFileName)
					.onChange(async (value) => {
						this.plugin.settings.dbFileName = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName('Delay after opening a new note')
			.setDesc(
				"This plugin shouldn't scroll if you used a link to the note header like [link](note.md#header). If it did, then increase the delay until everything works. If you are not using links to page sections, set the delay to zero (slider to the left). Slider values: 0-300 ms (default value: 100 ms)."
			)
			.addSlider((text) =>
				text
					.setLimits(0, 300, 10)
					.setValue(this.plugin.settings.delayAfterFileOpening)
					.onChange(async (value) => {
						this.plugin.settings.delayAfterFileOpening = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName('Delay between saving the scroll position to file')
			.setDesc(
				"Useful for multi-device users. If you don't want to wait until closing Obsidian to the scroll position been saved."			)
			.addSlider((text) =>
				text
					.setLimits(SAFE_DB_FLUSH_INTERVAL, SAFE_DB_FLUSH_INTERVAL * 10, 10)
					.setValue(this.plugin.settings.saveTimer)
					.onChange(async (value) => {
						this.plugin.settings.saveTimer = value;
						await this.plugin.saveSettings();
					})
			);
	}
}
