import { App, Editor, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting, Menu, MenuItem, normalizePath, TFile, Command } from 'obsidian';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as fs from 'fs';
import * as yaml from 'js-yaml';
import * as os from 'os';

const execPromise = promisify(exec);

interface LatexTemplate {
	name: string;
	path: string;
}

interface UniExportSetting {
	latexTemplates: LatexTemplate[];
	activeTemplateIndex: number;
	outputDirectory: string;
	imagesDirectory: string;
	pandocPath: string;
	additionalPandocArgs: string;
	useTemplateDirectoryAsResourcePath: boolean;
}

const DEFAULT_SETTINGS: UniExportSetting = {
	latexTemplates: [],
	activeTemplateIndex: -1,
	outputDirectory: '',
	imagesDirectory: './templates',
	pandocPath: 'pandoc',
	additionalPandocArgs: '',
	useTemplateDirectoryAsResourcePath: true
}

// File suggestion modal for template selection
class FileSuggestModal extends Modal {
	files: string[] = [];
	suggestEl: HTMLElement;
	inputEl: HTMLInputElement;
	onChoose: (result: string) => void;
	
	constructor(app: App, onChoose: (result: string) => void) {
		super(app);
		this.onChoose = onChoose;
	}
	
	onOpen() {
		const { contentEl } = this;
		
		contentEl.createEl('h2', { text: 'Select Template File' });
		
		// Create an input for manual path entry
		this.inputEl = contentEl.createEl('input', {
			type: 'text',
			placeholder: 'Enter path or start typing to search',
			cls: 'template-file-input'
		});
		this.inputEl.style.width = '100%';
		this.inputEl.style.marginBottom = '15px';
		
		// Create a suggestions container
		this.suggestEl = contentEl.createDiv({ cls: 'template-file-suggestions' });
		this.suggestEl.style.maxHeight = '300px';
		this.suggestEl.style.overflowY = 'auto';
		
		// Find all .tex files in the vault
		this.searchFiles();
		
		// Add event listener for input
		this.inputEl.addEventListener('input', () => {
			this.filterFiles(this.inputEl.value);
		});
		
		// Focus the input
		this.inputEl.focus();
		
		// Add confirm button
		const confirmBtn = contentEl.createEl('button', { text: 'Confirm', cls: 'mod-cta' });
		confirmBtn.style.marginTop = '15px';
		confirmBtn.addEventListener('click', () => {
			this.close();
			this.onChoose(this.inputEl.value);
		});
	}
	
	async searchFiles() {
		this.files = [];
		
		// Define valid LaTeX file extensions
		const latexExtensions = ['tex', 'latex', 'ltx'];
		
		// Search all LaTeX files in the vault
		const files = this.app.vault.getFiles();
		for (const file of files) {
			if (latexExtensions.includes(file.extension.toLowerCase())) {
				this.files.push(file.path);
			}
		}
		
		this.renderSuggestions();
	}
	
	filterFiles(query: string) {
		if (!query) {
			this.renderSuggestions();
			return;
		}
		
		const lowerQuery = query.toLowerCase();
		const filteredFiles = this.files.filter(file => 
			file.toLowerCase().includes(lowerQuery)
		);
		
		this.renderSuggestions(filteredFiles);
	}
	
	renderSuggestions(filesToRender = this.files) {
		this.suggestEl.empty();
		
		if (filesToRender.length === 0) {
			this.suggestEl.createEl('div', { 
				text: 'No .tex files found. You can still enter a path manually.',
				cls: 'template-file-empty'
			});
			return;
		}
		
		for (const file of filesToRender) {
			const fileEl = this.suggestEl.createEl('div', { 
				text: file,
				cls: 'template-file-item'
			});
			
			fileEl.style.padding = '5px';
			fileEl.style.cursor = 'pointer';
			fileEl.style.borderRadius = '4px';
			
			fileEl.addEventListener('mouseover', () => {
				fileEl.style.backgroundColor = 'var(--background-secondary)';
			});
			
			fileEl.addEventListener('mouseout', () => {
				fileEl.style.backgroundColor = '';
			});
			
			fileEl.addEventListener('click', () => {
				this.inputEl.value = file;
				this.close();
				this.onChoose(file);
			});
		}
	}
	
	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}

export default class UniExport extends Plugin {
	settings: UniExportSetting;
	styleEl: HTMLStyleElement | null = null;

	async onload() {
		await this.loadSettings();

		// Add a ribbon icon for converting current file
		this.addRibbonIcon('file-pdf', 'Convert to PDF', async (evt) => {
			const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
			if (activeView && activeView.file) {
				if (this.settings.latexTemplates.length === 0) {
					new Notice('No templates defined. Please add a template in settings.');
					return;
				}
				
				if (this.settings.latexTemplates.length === 1 || this.settings.activeTemplateIndex >= 0) {
					// If only one template or an active template is already selected, use it directly
					const templateIndex = this.settings.activeTemplateIndex >= 0 ? 
						this.settings.activeTemplateIndex : 0;
					await this.convertToPdf(activeView.file, templateIndex);
				} else {
					// Show template selection menu
					this.showTemplateMenu(evt, activeView.file);
				}
			} else {
				new Notice('No active markdown file');
			}
		});

		// Add a command for converting with active template
		this.addCommand({
			id: 'convert-current-file-to-pdf-active-template',
			name: 'Convert to PDF with active template',
			checkCallback: (checking: boolean) => {
				const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
				if (activeView && activeView.file && this.settings.activeTemplateIndex >= 0) {
					if (!checking) {
						this.convertToPdf(activeView.file, this.settings.activeTemplateIndex);
					}
					return true;
				}
				return false;
			}
		});

		// Add commands for each template
		this.refreshTemplateCommands();

		// Add a context menu item for files in the explorer
		this.registerEvent(
			this.app.workspace.on('file-menu', (menu, file) => {
				// Only show for markdown files
				if (!(file instanceof TFile) || file.extension !== 'md') {
					return;
				}
		
				// If no templates, add disabled menu item
				if (this.settings.latexTemplates.length === 0) {
					menu.addItem((item) => {
						item
							.setTitle('Convert to PDF')
							.setIcon('file-pdf')
							.setDisabled(true)
							.onClick(() => {
								new Notice('Please add a template in the plugin settings first');
							});
					});
					return;
				}
		
				// If only one template, add single menu item
				if (this.settings.latexTemplates.length === 1) {
					menu.addItem((item) => {
						item
							.setTitle('Convert to PDF')
							.setIcon('file-pdf')
							.onClick(() => this.convertToPdf(file, 0));
					});
					return;
				}
		
				// For multiple templates, create a submenu structure
				menu.addItem((item) => {
					item
						.setTitle('Convert to PDF')
						.setIcon('file-pdf');
				});
		
				// Add submenu items in a separate section
				if (this.settings.activeTemplateIndex >= 0) {
					const activeTemplate = this.settings.latexTemplates[this.settings.activeTemplateIndex];
					menu.addItem((item) => {
						item
							.setTitle(`${activeTemplate.name} (Default)`)
							.setIcon('star-list')
							.setSection('convert-pdf')
							.onClick(() => this.convertToPdf(file, this.settings.activeTemplateIndex));
					});
				}
		
				// Add separator
				menu.addSeparator();
		
				// Add other templates
				this.settings.latexTemplates.forEach((template, index) => {
					if (index !== this.settings.activeTemplateIndex) {
						menu.addItem((item) => {
							item
								.setTitle(template.name)
								.setSection('convert-pdf')
								.onClick(() => this.convertToPdf(file, index));
						});
					}
				});
			})
		);

		// Add a settings tab
		this.addSettingTab(new UniExportSettingsTab(this.app, this));
		
		// Add CSS for styling
		this.addStyles();
	}
	
	addStyles() {
		// Create style element once to avoid multiple injections
		if (!this.styleEl) {
			this.styleEl = document.createElement('style');
			this.styleEl.id = 'uni-export-styles';
			document.head.appendChild(this.styleEl);
		}
		
		this.styleEl.textContent = `
			.default-template {
				background-color: var(--background-secondary);
				border-left: 3px solid var(--interactive-accent);
				padding-left: 8px;
				border-radius: 4px;
			}
			.default-template-indicator {
				color: var(--text-accent);
				font-style: italic;
			}
			.yaml-example {
				background-color: var(--background-secondary);
				padding: 10px;
				border-radius: 4px;
				overflow-x: auto;
			}
			.image-info-container ul {
				margin-left: 20px;
			}
			.template-file-item:hover {
				background-color: var(--background-secondary);
			}
		`;
	}

	refreshTemplateCommands() {
		// Get all commands
		const commands = (this.app as any).commands.listCommands();
		
		// Find and remove our template commands
		commands.forEach((cmd: Command) => {
			if (cmd.id.startsWith('uni-export:template-')) {
				(this.app as any).commands.removeCommand(cmd.id);
			}
		});

		// Add new commands for each template
		this.settings.latexTemplates.forEach((template, index) => {
			this.addCommand({
				id: `template-${index}`,
				name: `Convert to PDF with template: ${template.name}`,
				checkCallback: (checking: boolean) => {
					const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
					if (activeView && activeView.file) {
						if (!checking) {
							this.convertToPdf(activeView.file, index);
						}
						return true;
					}
					return false;
				}
			});
		});
	}

	showTemplateMenu(evt: MouseEvent, file: TFile) {
		const menu = new Menu();
		
		this.settings.latexTemplates.forEach((template, index) => {
			menu.addItem((item) => {
				item
					.setTitle(template.name)
					.onClick(() => {
						this.convertToPdf(file, index);
					});
			});
		});
		
		// Add option to set active template
		menu.addSeparator();
		menu.addItem((item) => {
			item
				.setTitle('Set default template...')
				.setIcon('settings-2')
				.onClick(() => {
					this.showSetDefaultTemplateMenu(evt);
				});
		});
		
		menu.showAtMouseEvent(evt);
	}
	
	showSetDefaultTemplateMenu(evt: MouseEvent) {
		const menu = new Menu();
		
		this.settings.latexTemplates.forEach((template, index) => {
			menu.addItem((item) => {
				item
					.setTitle(template.name)
					.setChecked(index === this.settings.activeTemplateIndex)
					.onClick(async () => {
						this.settings.activeTemplateIndex = index;
						await this.saveSettings();
						new Notice(`Default template set to: ${template.name}`);
					});
			});
		});
		
		// Add option to clear default template
		menu.addSeparator();
		menu.addItem((item) => {
			item
				.setTitle('Clear default template')
				.setChecked(this.settings.activeTemplateIndex === -1)
				.onClick(async () => {
					this.settings.activeTemplateIndex = -1;
					await this.saveSettings();
					new Notice('Default template cleared');
				});
		});
		
		menu.showAtMouseEvent(evt);
	}

	onunload() {
		// Clean up styles
		if (this.styleEl && this.styleEl.parentNode) {
			this.styleEl.parentNode.removeChild(this.styleEl);
		}
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
		this.refreshTemplateCommands();
	}

	// Extract YAML frontmatter from markdown content
	extractFrontmatter(content: string): Record<string, any> {
		const frontmatterRegex = /^---\s*([\s\S]*?)\s*---/;
		const match = content.match(frontmatterRegex);
		
		if (match && match[1]) {
			try {
				return yaml.load(match[1]) as Record<string, any>;
			} catch (e) {
				console.error("Error parsing YAML frontmatter:", e);
				new Notice("Error parsing YAML frontmatter in document");
			}
		}
		
		return {};
	}

	// Create a metadata file for pandoc with YAML variables
	async createMetadataFile(frontmatter: Record<string, any>): Promise<string> {
		const tempDir = os.tmpdir();
		const metadataPath = path.join(tempDir, `pandoc-metadata-${Date.now()}.yaml`);
		
		const yamlContent = yaml.dump(frontmatter);
		
		await fs.promises.writeFile(metadataPath, yamlContent, 'utf8');
		return metadataPath;
	}

	async convertToPdf(file: TFile, templateIndex: number) {
		try {
			// Validate template index
			if (templateIndex < 0 || templateIndex >= this.settings.latexTemplates.length) {
				new Notice('Invalid template selection');
				return;
			}
	
			const selectedTemplate = this.settings.latexTemplates[templateIndex];
	
			// Get the vault path and full file path
			// Check if we're using a FileSystemAdapter
			const adapter = this.app.vault.adapter;
			if (!('getBasePath' in adapter)) {
				new Notice('This plugin only works with a local vault');
				return;
			}
			const vaultPath = (adapter as any).getBasePath();
			const fullInputPath = path.join(vaultPath, normalizePath(file.path));
	
			// Read the markdown file and extract frontmatter
			const content = await this.app.vault.read(file);
			const frontmatter = this.extractFrontmatter(content);
	
			// Create a temporary metadata file with the YAML frontmatter
			const metadataPath = await this.createMetadataFile(frontmatter);
	
			// Determine output path
			let outputPath = fullInputPath.replace(/\.md$/, '.pdf');
			if (this.settings.outputDirectory) {
				const fileName = path.basename(outputPath);
				outputPath = path.join(vaultPath, this.settings.outputDirectory, fileName);
	
				// Ensure output directory exists
				const outputDir = path.dirname(outputPath);
				if (!fs.existsSync(outputDir)) {
					fs.mkdirSync(outputDir, { recursive: true });
				}
			}
	
			// Normalize paths to use forward slashes
			const normalizePathForPandoc = (p: string) => p.replace(/\\/g, '/');
	
			// Build pandoc command
			let command = `"${this.settings.pandocPath}" "${normalizePathForPandoc(fullInputPath)}" -o "${normalizePathForPandoc(outputPath)}"`;
	
			// Add metadata file
			command += ` --metadata-file="${normalizePathForPandoc(metadataPath)}"`;
	
			// Add template
			const templatePath = path.join(vaultPath, selectedTemplate.path);
	
			// Check if template exists
			if (!fs.existsSync(templatePath)) {
				new Notice(`Template file not found: ${selectedTemplate.path}`);
				return;
			}
	
			command += ` --template="${normalizePathForPandoc(templatePath)}"`;
	
			// Add PDF engine
			command += ` --pdf-engine=xelatex`;
	
			// COMPLETELY REFACTORED RESOURCE PATH HANDLING
			// Only use the specified images directory if it exists
			if (this.settings.imagesDirectory && this.settings.imagesDirectory.trim() !== '') {
				// Handle both absolute and relative paths
				let imagesDirPath;
				if (path.isAbsolute(this.settings.imagesDirectory)) {
					imagesDirPath = this.settings.imagesDirectory;
				} else {
					imagesDirPath = path.join(vaultPath, this.settings.imagesDirectory);
				}
				
				if (fs.existsSync(imagesDirPath)) {
					command += ` --resource-path="${normalizePathForPandoc(imagesDirPath)}"`;
					console.log(`Using images directory: ${imagesDirPath}`);
				} else {
					console.warn(`Images directory not found: ${this.settings.imagesDirectory}`);
					// Fallback to current file directory
					command += ` --resource-path="${normalizePathForPandoc(path.dirname(fullInputPath))}"`;
					console.log(`Falling back to current file directory: ${path.dirname(fullInputPath)}`);
				}
			} else if (this.settings.useTemplateDirectoryAsResourcePath) {
				// If no images directory specified but template directory is enabled, use that
				const templateDir = path.dirname(templatePath);
				command += ` --resource-path="${normalizePathForPandoc(templateDir)}"`;
				console.log(`Using template directory: ${templateDir}`);
			} else {
				// If nothing else is specified, use current file directory
				command += ` --resource-path="${normalizePathForPandoc(path.dirname(fullInputPath))}"`;
				console.log(`Using current file directory: ${path.dirname(fullInputPath)}`);
			}
	
			// Add extract-media option to have pandoc extract embedded images
			command += ` --extract-media="${normalizePathForPandoc(path.dirname(outputPath))}"`;
	
			// Add additional pandoc arguments if specified
			if (this.settings.additionalPandocArgs && this.settings.additionalPandocArgs.trim() !== '') {
				command += ` ${this.settings.additionalPandocArgs}`;
			}
	
			new Notice(`Converting to PDF using template: ${selectedTemplate.name}...`);
	
			console.log("Running pandoc command:", command);
	
			try {
				await execPromise(command);
				new Notice(`PDF created at ${this.settings.outputDirectory ? `${this.settings.outputDirectory}/${path.basename(outputPath)}` : file.path.replace(/\.md$/, '.pdf')}`);
	
				// Clean up the temporary metadata file
				try {
					fs.unlinkSync(metadataPath);
				} catch (e) {
					console.warn("Could not delete temporary metadata file:", e);
				}
			} catch (error) {
				console.error("Pandoc command that failed:", command);
				console.error("Pandoc error:", error);
				
				// Show full error for debugging
				new Notice(`Error converting to PDF: ${error.message}`);
			}
	
		} catch (error) {
			console.error('Error converting to PDF:', error);
			new Notice(`Error converting to PDF: ${error.message}`);
		}
	}
}

export class UniExportSettingsTab extends PluginSettingTab {
    plugin: UniExport;
    templateContainerEl: HTMLElement;

    constructor(app: App, plugin: UniExport) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;

        // Clear any existing content
        containerEl.empty();

        // Add a heading
        containerEl.createEl('h2', { text: 'Pandoc PDF Converter Settings' });

        // Example setting: Pandoc Path
        new Setting(containerEl)
            .setName('Pandoc Path')
            .setDesc('Path to the pandoc executable. Default is just "pandoc" which works if pandoc is in your PATH.')
            .addText(text => text
                .setPlaceholder('pandoc')
                .setValue(this.plugin.settings.pandocPath)
                .onChange(async (value) => {
                    this.plugin.settings.pandocPath = value;
                    await this.plugin.saveSettings();
                }));

        // Add more settings here...
        // For example, you can add settings for LaTeX templates, output directory, etc.

        // LaTeX Templates Section
        containerEl.createEl('h3', { text: 'LaTeX Templates' });

        this.templateContainerEl = containerEl.createDiv();
        this.refreshTemplatesUI();

        // Add new template button
        new Setting(containerEl)
            .setName('Add Template')
            .setDesc('Add a new LaTeX template')
            .addButton(button => button
                .setButtonText('Add Template')
                .setCta()
                .onClick(() => {
                    this.plugin.settings.latexTemplates.push({
                        name: 'New Template',
                        path: ''
                    });
                    this.plugin.saveSettings().then(() => {
                        this.refreshTemplatesUI();
                    });
                }));

        // Output Directory
        new Setting(containerEl)
            .setName('Output Directory')
            .setDesc('Directory to save PDFs (relative to vault root). Leave empty to save alongside the markdown file.')
            .addText(text => text
                .setPlaceholder('PDFs')
                .setValue(this.plugin.settings.outputDirectory)
                .onChange(async (value) => {
                    this.plugin.settings.outputDirectory = value;
                    await this.plugin.saveSettings();
                }));

        // Images Directory
        new Setting(containerEl)
            .setName('Images Directory')
            .setDesc('Directory containing images used in your documents (relative to vault root). Leave empty to use automatic detection.')
            .addText(text => text
                .setPlaceholder('images')
                .setValue(this.plugin.settings.imagesDirectory)
                .onChange(async (value) => {
                    this.plugin.settings.imagesDirectory = value;
                    await this.plugin.saveSettings();
                }));

        // Use Template Directory
        new Setting(containerEl)
            .setName('Use Template Directory')
            .setDesc('Automatically use the template directory as a resource path for images and other assets')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.useTemplateDirectoryAsResourcePath)
                .onChange(async (value) => {
                    this.plugin.settings.useTemplateDirectoryAsResourcePath = value;
                    await this.plugin.saveSettings();
                }));

        // Additional Pandoc Arguments
        new Setting(containerEl)
            .setName('Additional Pandoc Arguments')
            .setDesc('Additional command-line arguments to pass to pandoc')
            .addText(text => text
                .setPlaceholder('--toc -V geometry:margin=1in')
                .setValue(this.plugin.settings.additionalPandocArgs)
                .onChange(async (value) => {
                    this.plugin.settings.additionalPandocArgs = value;
                    await this.plugin.saveSettings();
                }));

        // Images and Resource Paths Information Section
        containerEl.createEl('h3', { text: 'Image Path Information' });

        const imageInfoEl = containerEl.createEl('div', {
            cls: 'image-info-container',
        });

        imageInfoEl.createEl('p', {
            text: 'To include images in your PDFs, you have several options:'
        });

        imageInfoEl.createEl('ul', {}).innerHTML = `
            <li><strong>Images Directory</strong>: Set a specific directory for images above</li>
            <li><strong>Template Directory</strong>: Enable the option to use the template directory for images</li>
            <li><strong>Document Location</strong>: Images next to your markdown file will be found automatically</li>
            <li><strong>Vault Root</strong>: Images in the root of your vault will be found automatically</li>
        `;

        imageInfoEl.createEl('p', {
            text: 'If you still have issues with images, you can check the error console to see the full pandoc command.'
        });

        // YAML Frontmatter Information Section
        containerEl.createEl('h3', { text: 'YAML Frontmatter Information' });

        const yamlInfoEl = containerEl.createEl('div', {
            cls: 'yaml-info-container',
        });

        yamlInfoEl.createEl('p', {
            text: 'This plugin supports YAML frontmatter variables that will be passed to your LaTeX template. Example frontmatter:'
        });

        const yamlExample = yamlInfoEl.createEl('pre', {
            cls: 'yaml-example',
            text: `---
title: "Titel der Hausarbeit"
subtitle: "Untertitel, falls nötig"
kurztitel: "Hausarbeit"
vorname: "Max"
nachname: "Mustermann"
semester: "Wintersemester 2024/25"
seminar: "Titel des Seminars"
professor: "Prof. Dr. Irgendwer"
address: "Musterstraße 123"
email: "max@example.com"
matrikel: "12345678"
studiengang: "Philosophie M.A."
modul: "XY"
pruefungsnr: "XY"
abgabedatum: "1. März 2025"
---`
        });

        yamlInfoEl.createEl('p', {
            text: 'These variables will be available in your LaTeX template as $variable$ placeholders.'
        });
    }

    refreshTemplatesUI() {
		this.templateContainerEl.empty();
	
		if (this.plugin.settings.latexTemplates.length === 0) {
			this.templateContainerEl.createEl('p', {
				text: 'No templates defined. Add a template to get started.'
			});
			return;
		}
	
		// For each template, create settings
		this.plugin.settings.latexTemplates.forEach((template, index) => {
			const templateSetting = new Setting(this.templateContainerEl)
				.setName(`Template ${index + 1}`)
				.setDesc('Define a LaTeX template for PDF conversion')
				.addText(text => text
					.setPlaceholder('Template Name')
					.setValue(template.name)
					.onChange(async (value) => {
						this.plugin.settings.latexTemplates[index].name = value;
						await this.plugin.saveSettings();
					}))
				.addText(text => text
					.setPlaceholder('templates/my-template.tex')
					.setValue(template.path)
					.onChange(async (value) => {
						this.plugin.settings.latexTemplates[index].path = value;
						await this.plugin.saveSettings();
					}))
				.addExtraButton(button => button
					.setIcon('cross')
					.setTooltip('Delete template')
					.onClick(async () => {
						// Adjust active template index if needed
						if (this.plugin.settings.activeTemplateIndex === index) {
							this.plugin.settings.activeTemplateIndex = -1;
						} else if (this.plugin.settings.activeTemplateIndex > index) {
							this.plugin.settings.activeTemplateIndex--;
						}
	
						this.plugin.settings.latexTemplates.splice(index, 1);
						await this.plugin.saveSettings();
						this.refreshTemplatesUI();
					}))
				.addExtraButton(button => {
					button
						.setIcon('check')
						.setTooltip('Set as default template')
						.onClick(async () => {
							this.plugin.settings.activeTemplateIndex = index;
							await this.plugin.saveSettings();
							this.refreshTemplatesUI();
							new Notice(`Default template set to: ${template.name}`);
						});
	
					// Highlight the active template
					if (this.plugin.settings.activeTemplateIndex === index) {
						button.extraSettingsEl.addClass('active-template-button');
					}
				});
	
			// Move the if block outside the callback
			if (this.plugin.settings.activeTemplateIndex === index) {
				templateSetting.controlEl.addClass('active-template');
			}
	
			// Add file browser button
			templateSetting.addExtraButton((button) => {
				button
					.setIcon('folder')
					.setTooltip('Browse for template file')
					.onClick(async () => {
						const modal = new FileSuggestModal(this.app, async (result) => {
							this.plugin.settings.latexTemplates[index].path = result;
							await this.plugin.saveSettings();
							this.refreshTemplatesUI();
						});
						modal.open();
					});
			});
	
			// Add visual indicator for default template
			if (this.plugin.settings.activeTemplateIndex === index) {
				templateSetting.nameEl.createSpan({
					text: ' (Default)',
					cls: 'default-template-indicator'
				});
				templateSetting.settingEl.addClass('default-template');
			}
		});
	}
}