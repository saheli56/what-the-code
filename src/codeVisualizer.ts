import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

interface FileNode {
    id: string;
    name: string;
    path: string;
    relativePath: string;
    type: 'file' | 'folder';
    extension?: string;
    children?: FileNode[];
    imports?: string[];
    exports?: string[];
    size?: number;
    lines?: number;
}

interface DependencyLink {
    source: string;
    target: string;
    type: 'import' | 'export' | 'reference';
}

export class CodeVisualizerProvider implements vscode.Disposable {
    private panel: vscode.WebviewPanel | undefined;
    private disposables: vscode.Disposable[] = [];
    private context: vscode.ExtensionContext;

    constructor(context: vscode.ExtensionContext) {
        this.context = context;
    }

    async openVisualizer(): Promise<void> {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            vscode.window.showWarningMessage('No workspace folder found. Open a project to visualize.');
            return;
        }

        if (this.panel) {
            this.panel.reveal(vscode.ViewColumn.One);
            return;
        }

        this.panel = vscode.window.createWebviewPanel(
            'codeVisualizer',
            '🌳 Code Visualizer',
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')]
            }
        );

        this.panel.iconPath = vscode.Uri.joinPath(this.context.extensionUri, 'media', 'search.svg');

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'Building code visualization...',
            cancellable: false
        }, async (progress) => {
            progress.report({ increment: 20, message: 'Scanning files...' });
            const fileTree = await this.buildFileTree(workspaceFolder.uri.fsPath);
            
            progress.report({ increment: 40, message: 'Analyzing dependencies...' });
            const dependencies = await this.analyzeDependencies(workspaceFolder.uri.fsPath);
            
            progress.report({ increment: 30, message: 'Generating visualization...' });
            this.panel!.webview.html = this.getWebviewContent(fileTree, dependencies);
            
            progress.report({ increment: 10, message: 'Complete!' });
        });

        this.panel.webview.onDidReceiveMessage(
            async (message) => {
                switch (message.command) {
                    case 'openFile':
                        const fileUri = vscode.Uri.file(message.filePath);
                        const document = await vscode.workspace.openTextDocument(fileUri);
                        await vscode.window.showTextDocument(document, vscode.ViewColumn.Beside);
                        break;
                    case 'refresh':
                        await this.refreshVisualization();
                        break;
                    case 'showInfo':
                        vscode.window.showInformationMessage(message.text);
                        break;
                }
            },
            undefined,
            this.disposables
        );

        this.panel.onDidDispose(
            () => {
                this.panel = undefined;
            },
            undefined,
            this.disposables
        );
    }

    private async refreshVisualization(): Promise<void> {
        if (!this.panel) return;

        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) return;

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'Refreshing visualization...',
            cancellable: false
        }, async (progress) => {
            progress.report({ increment: 30, message: 'Scanning files...' });
            const fileTree = await this.buildFileTree(workspaceFolder.uri.fsPath);
            
            progress.report({ increment: 40, message: 'Analyzing dependencies...' });
            const dependencies = await this.analyzeDependencies(workspaceFolder.uri.fsPath);
            
            progress.report({ increment: 30, message: 'Updating view...' });
            this.panel!.webview.html = this.getWebviewContent(fileTree, dependencies);
        });
    }

    private async buildFileTree(rootPath: string): Promise<FileNode> {
        const config = vscode.workspace.getConfiguration('whatTheCode');
        const includedExtensions = config.get<string[]>('includedExtensions', [
            '.js', '.ts', '.jsx', '.tsx', '.py', '.java', '.cs', '.cpp', '.c', '.h', '.go', '.rs', '.php', '.rb', '.vue', '.svelte'
        ]);

        const excludePatterns = [
            'node_modules', 'dist', 'build', '.git', 'coverage', '__pycache__', 
            '.next', '.nuxt', 'vendor', 'target', 'bin', 'obj', '.vscode'
        ];

        const rootName = path.basename(rootPath);
        const rootNode: FileNode = {
            id: rootPath,
            name: rootName,
            path: rootPath,
            relativePath: '',
            type: 'folder',
            children: []
        };

        const processDirectory = async (dirPath: string, parentNode: FileNode, depth: number = 0): Promise<void> => {
            if (depth > 10) return; // Prevent too deep recursion

            try {
                const entries = fs.readdirSync(dirPath, { withFileTypes: true });
                
                for (const entry of entries) {
                    if (excludePatterns.includes(entry.name) || entry.name.startsWith('.')) {
                        continue;
                    }

                    const fullPath = path.join(dirPath, entry.name);
                    const relativePath = path.relative(rootPath, fullPath);

                    if (entry.isDirectory()) {
                        const folderNode: FileNode = {
                            id: fullPath,
                            name: entry.name,
                            path: fullPath,
                            relativePath,
                            type: 'folder',
                            children: []
                        };
                        parentNode.children!.push(folderNode);
                        await processDirectory(fullPath, folderNode, depth + 1);
                    } else if (entry.isFile()) {
                        const ext = path.extname(entry.name);
                        if (includedExtensions.includes(ext)) {
                            try {
                                const stats = fs.statSync(fullPath);
                                const content = fs.readFileSync(fullPath, 'utf8');
                                const lines = content.split('\n').length;
                                const imports = this.extractImports(content, ext);
                                const exports = this.extractExports(content, ext);

                                const fileNode: FileNode = {
                                    id: fullPath,
                                    name: entry.name,
                                    path: fullPath,
                                    relativePath,
                                    type: 'file',
                                    extension: ext,
                                    size: stats.size,
                                    lines,
                                    imports,
                                    exports
                                };
                                parentNode.children!.push(fileNode);
                            } catch (error) {
                                // Skip files that can't be read
                            }
                        }
                    }
                }

                // Sort: folders first, then files alphabetically
                parentNode.children!.sort((a, b) => {
                    if (a.type !== b.type) {
                        return a.type === 'folder' ? -1 : 1;
                    }
                    return a.name.localeCompare(b.name);
                });

            } catch (error) {
                console.error(`Error processing directory ${dirPath}:`, error);
            }
        };

        await processDirectory(rootPath, rootNode);
        return rootNode;
    }

    private extractImports(content: string, extension: string): string[] {
        const imports: string[] = [];
        
        // ES6 imports
        const es6ImportRegex = /import\s+(?:(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)\s+from\s+)?['"]([^'"]+)['"]/g;
        let match;
        while ((match = es6ImportRegex.exec(content)) !== null) {
            imports.push(match[1]);
        }

        // CommonJS require
        const requireRegex = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
        while ((match = requireRegex.exec(content)) !== null) {
            imports.push(match[1]);
        }

        // Python imports
        if (extension === '.py') {
            const pythonImportRegex = /(?:from\s+(\S+)\s+import|import\s+(\S+))/g;
            while ((match = pythonImportRegex.exec(content)) !== null) {
                imports.push(match[1] || match[2]);
            }
        }

        return [...new Set(imports)];
    }

    private extractExports(content: string, extension: string): string[] {
        const exports: string[] = [];
        
        // ES6 exports
        const exportRegex = /export\s+(?:default\s+)?(?:const|let|var|function|class|async\s+function)\s+(\w+)/g;
        let match;
        while ((match = exportRegex.exec(content)) !== null) {
            exports.push(match[1]);
        }

        // Named exports
        const namedExportRegex = /export\s*\{\s*([^}]+)\s*\}/g;
        while ((match = namedExportRegex.exec(content)) !== null) {
            const names = match[1].split(',').map(n => n.trim().split(' ')[0]);
            exports.push(...names);
        }

        return [...new Set(exports)];
    }

    private async analyzeDependencies(rootPath: string): Promise<DependencyLink[]> {
        const links: DependencyLink[] = [];
        const fileMap = new Map<string, string>();

        // Build a map of module names to file paths
        const buildFileMap = (dir: string) => {
            try {
                const entries = fs.readdirSync(dir, { withFileTypes: true });
                for (const entry of entries) {
                    if (['node_modules', 'dist', 'build', '.git'].includes(entry.name)) continue;
                    
                    const fullPath = path.join(dir, entry.name);
                    if (entry.isDirectory()) {
                        buildFileMap(fullPath);
                    } else if (entry.isFile()) {
                        const relativePath = path.relative(rootPath, fullPath);
                        const baseName = path.basename(entry.name, path.extname(entry.name));
                        fileMap.set(relativePath, fullPath);
                        fileMap.set('./' + relativePath.replace(/\\/g, '/'), fullPath);
                        fileMap.set(baseName, fullPath);
                    }
                }
            } catch (error) {
                // Skip directories that can't be read
            }
        };

        buildFileMap(rootPath);

        // Analyze imports for each file
        const analyzeFile = (filePath: string) => {
            try {
                const content = fs.readFileSync(filePath, 'utf8');
                const ext = path.extname(filePath);
                const imports = this.extractImports(content, ext);
                
                for (const imp of imports) {
                    // Skip external packages
                    if (!imp.startsWith('.') && !imp.startsWith('/')) continue;
                    
                    const resolvedPath = this.resolveImportPath(filePath, imp, rootPath);
                    if (resolvedPath && fs.existsSync(resolvedPath)) {
                        links.push({
                            source: filePath,
                            target: resolvedPath,
                            type: 'import'
                        });
                    }
                }
            } catch (error) {
                // Skip files that can't be analyzed
            }
        };

        const processDir = (dir: string) => {
            try {
                const entries = fs.readdirSync(dir, { withFileTypes: true });
                for (const entry of entries) {
                    if (['node_modules', 'dist', 'build', '.git'].includes(entry.name)) continue;
                    
                    const fullPath = path.join(dir, entry.name);
                    if (entry.isDirectory()) {
                        processDir(fullPath);
                    } else if (entry.isFile() && ['.js', '.ts', '.jsx', '.tsx'].includes(path.extname(entry.name))) {
                        analyzeFile(fullPath);
                    }
                }
            } catch (error) {
                // Skip directories that can't be processed
            }
        };

        processDir(rootPath);
        return links;
    }

    private resolveImportPath(fromFile: string, importPath: string, rootPath: string): string | null {
        const fromDir = path.dirname(fromFile);
        let resolved = path.resolve(fromDir, importPath);
        
        // Try with different extensions
        const extensions = ['.ts', '.tsx', '.js', '.jsx', '.json', ''];
        for (const ext of extensions) {
            const withExt = resolved + ext;
            if (fs.existsSync(withExt)) {
                return withExt;
            }
            // Try index file
            const indexPath = path.join(resolved, `index${ext}`);
            if (fs.existsSync(indexPath)) {
                return indexPath;
            }
        }
        
        return null;
    }

    private getWebviewContent(fileTree: FileNode, dependencies: DependencyLink[]): string {
        const treeData = JSON.stringify(fileTree);
        const linksData = JSON.stringify(dependencies);

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Code Visualizer</title>
    <style>
        :root {
            --bg-primary: #1e1e1e;
            --bg-secondary: #252526;
            --bg-tertiary: #2d2d30;
            --text-primary: #cccccc;
            --text-secondary: #9d9d9d;
            --accent-blue: #007acc;
            --accent-green: #4ec9b0;
            --accent-orange: #ce9178;
            --accent-purple: #c586c0;
            --accent-yellow: #dcdcaa;
            --border-color: #3c3c3c;
            --hover-bg: #2a2d2e;
            --node-file: #4fc3f7;
            --node-folder: #ffb74d;
            --link-color: #555;
        }

        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
            background: var(--bg-primary);
            color: var(--text-primary);
            overflow: hidden;
            height: 100vh;
        }

        .container {
            display: flex;
            flex-direction: column;
            height: 100vh;
        }

        .header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 12px 20px;
            background: var(--bg-secondary);
            border-bottom: 1px solid var(--border-color);
            flex-shrink: 0;
        }

        .header h1 {
            font-size: 18px;
            font-weight: 500;
            display: flex;
            align-items: center;
            gap: 10px;
        }

        .header h1 span {
            font-size: 24px;
        }

        .controls {
            display: flex;
            gap: 10px;
            align-items: center;
        }

        .btn {
            padding: 6px 14px;
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-size: 13px;
            display: flex;
            align-items: center;
            gap: 6px;
            transition: all 0.2s;
        }

        .btn-primary {
            background: var(--accent-blue);
            color: white;
        }

        .btn-primary:hover {
            background: #1e8ad2;
        }

        .btn-secondary {
            background: var(--bg-tertiary);
            color: var(--text-primary);
            border: 1px solid var(--border-color);
        }

        .btn-secondary:hover {
            background: var(--hover-bg);
        }

        .view-toggle {
            display: flex;
            border-radius: 4px;
            overflow: hidden;
            border: 1px solid var(--border-color);
        }

        .view-toggle button {
            padding: 6px 12px;
            border: none;
            background: var(--bg-tertiary);
            color: var(--text-secondary);
            cursor: pointer;
            font-size: 12px;
            transition: all 0.2s;
        }

        .view-toggle button.active {
            background: var(--accent-blue);
            color: white;
        }

        .view-toggle button:hover:not(.active) {
            background: var(--hover-bg);
        }

        .main-content {
            display: flex;
            flex: 1;
            overflow: hidden;
        }

        .sidebar {
            width: 280px;
            background: var(--bg-secondary);
            border-right: 1px solid var(--border-color);
            display: flex;
            flex-direction: column;
            overflow: hidden;
        }

        .sidebar-header {
            padding: 12px 16px;
            border-bottom: 1px solid var(--border-color);
            font-size: 12px;
            font-weight: 600;
            text-transform: uppercase;
            color: var(--text-secondary);
        }

        .file-tree {
            flex: 1;
            overflow-y: auto;
            padding: 8px 0;
        }

        .tree-item {
            display: flex;
            align-items: center;
            padding: 4px 16px;
            cursor: pointer;
            font-size: 13px;
            transition: background 0.1s;
            white-space: nowrap;
        }

        .tree-item:hover {
            background: var(--hover-bg);
        }

        .tree-item.selected {
            background: rgba(0, 122, 204, 0.3);
        }

        .tree-item .icon {
            margin-right: 8px;
            font-size: 14px;
            width: 16px;
            text-align: center;
        }

        .tree-item .name {
            flex: 1;
            overflow: hidden;
            text-overflow: ellipsis;
        }

        .tree-item .badge {
            font-size: 10px;
            padding: 2px 6px;
            border-radius: 10px;
            background: var(--bg-tertiary);
            color: var(--text-secondary);
            margin-left: 8px;
        }

        .tree-children {
            margin-left: 16px;
        }

        .tree-folder > .tree-item .icon {
            color: var(--node-folder);
        }

        .tree-file > .tree-item .icon {
            color: var(--node-file);
        }

        .visualization-area {
            flex: 1;
            position: relative;
            overflow: hidden;
        }

        #graph-container {
            width: 100%;
            height: 100%;
            background: var(--bg-primary);
        }

        svg {
            width: 100%;
            height: 100%;
        }

        .node {
            cursor: pointer;
        }

        .node circle {
            stroke-width: 2px;
            transition: all 0.2s;
        }

        .node:hover circle {
            stroke-width: 3px;
            filter: brightness(1.2);
        }

        .node text {
            font-size: 11px;
            fill: var(--text-primary);
            pointer-events: none;
        }

        .link {
            fill: none;
            stroke: var(--link-color);
            stroke-width: 1.5px;
            stroke-opacity: 0.6;
        }

        .link.highlighted {
            stroke: var(--accent-blue);
            stroke-width: 2px;
            stroke-opacity: 1;
        }

        .tooltip {
            position: absolute;
            background: var(--bg-secondary);
            border: 1px solid var(--border-color);
            border-radius: 6px;
            padding: 12px;
            font-size: 12px;
            pointer-events: none;
            z-index: 1000;
            max-width: 300px;
            box-shadow: 0 4px 12px rgba(0,0,0,0.3);
            display: none;
        }

        .tooltip.visible {
            display: block;
        }

        .tooltip-title {
            font-weight: 600;
            margin-bottom: 8px;
            color: var(--accent-blue);
        }

        .tooltip-row {
            display: flex;
            justify-content: space-between;
            margin: 4px 0;
        }

        .tooltip-label {
            color: var(--text-secondary);
        }

        .tooltip-value {
            color: var(--text-primary);
        }

        .stats-bar {
            display: flex;
            gap: 20px;
            padding: 8px 20px;
            background: var(--bg-tertiary);
            border-top: 1px solid var(--border-color);
            font-size: 12px;
            flex-shrink: 0;
        }

        .stat-item {
            display: flex;
            align-items: center;
            gap: 6px;
        }

        .stat-label {
            color: var(--text-secondary);
        }

        .stat-value {
            font-weight: 600;
            color: var(--accent-green);
        }

        .legend {
            position: absolute;
            bottom: 20px;
            right: 20px;
            background: var(--bg-secondary);
            border: 1px solid var(--border-color);
            border-radius: 6px;
            padding: 12px;
            font-size: 11px;
        }

        .legend-title {
            font-weight: 600;
            margin-bottom: 8px;
            color: var(--text-secondary);
        }

        .legend-item {
            display: flex;
            align-items: center;
            gap: 8px;
            margin: 4px 0;
        }

        .legend-color {
            width: 12px;
            height: 12px;
            border-radius: 50%;
        }

        .zoom-controls {
            position: absolute;
            top: 20px;
            right: 20px;
            display: flex;
            flex-direction: column;
            gap: 4px;
        }

        .zoom-btn {
            width: 32px;
            height: 32px;
            border: 1px solid var(--border-color);
            background: var(--bg-secondary);
            color: var(--text-primary);
            border-radius: 4px;
            cursor: pointer;
            font-size: 16px;
            display: flex;
            align-items: center;
            justify-content: center;
            transition: all 0.2s;
        }

        .zoom-btn:hover {
            background: var(--hover-bg);
        }

        .empty-state {
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            height: 100%;
            color: var(--text-secondary);
        }

        .empty-state-icon {
            font-size: 64px;
            margin-bottom: 16px;
        }

        .search-box {
            padding: 8px 16px;
            border-bottom: 1px solid var(--border-color);
        }

        .search-input {
            width: 100%;
            padding: 6px 10px;
            border: 1px solid var(--border-color);
            border-radius: 4px;
            background: var(--bg-tertiary);
            color: var(--text-primary);
            font-size: 12px;
        }

        .search-input:focus {
            outline: none;
            border-color: var(--accent-blue);
        }

        .collapsible {
            overflow: hidden;
            transition: max-height 0.2s ease-out;
        }

        .collapsed {
            max-height: 0;
        }

        .expand-icon {
            transition: transform 0.2s;
            display: inline-block;
        }

        .expanded .expand-icon {
            transform: rotate(90deg);
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1><span>🌳</span> Code Visualizer</h1>
            <div class="controls">
                <div class="view-toggle">
                    <button id="tree-view-btn" class="active">Tree</button>
                    <button id="graph-view-btn">Graph</button>
                </div>
                <button class="btn btn-secondary" id="refresh-btn">
                    🔄 Refresh
                </button>
                <button class="btn btn-secondary" id="expand-all-btn">
                    📂 Expand All
                </button>
                <button class="btn btn-secondary" id="collapse-all-btn">
                    📁 Collapse All
                </button>
            </div>
        </div>
        
        <div class="main-content">
            <div class="sidebar">
                <div class="sidebar-header">📁 Project Structure</div>
                <div class="search-box">
                    <input type="text" class="search-input" id="search-input" placeholder="Search files...">
                </div>
                <div class="file-tree" id="file-tree"></div>
            </div>
            
            <div class="visualization-area">
                <div id="graph-container"></div>
                
                <div class="zoom-controls">
                    <button class="zoom-btn" id="zoom-in">+</button>
                    <button class="zoom-btn" id="zoom-out">−</button>
                    <button class="zoom-btn" id="zoom-reset">⟲</button>
                </div>
                
                <div class="legend">
                    <div class="legend-title">Legend</div>
                    <div class="legend-item">
                        <div class="legend-color" style="background: #ffb74d;"></div>
                        <span>Folder</span>
                    </div>
                    <div class="legend-item">
                        <div class="legend-color" style="background: #4fc3f7;"></div>
                        <span>TypeScript/JavaScript</span>
                    </div>
                    <div class="legend-item">
                        <div class="legend-color" style="background: #81c784;"></div>
                        <span>Python</span>
                    </div>
                    <div class="legend-item">
                        <div class="legend-color" style="background: #e57373;"></div>
                        <span>Other</span>
                    </div>
                </div>
            </div>
        </div>
        
        <div class="tooltip" id="tooltip">
            <div class="tooltip-title" id="tooltip-title"></div>
            <div class="tooltip-row">
                <span class="tooltip-label">Type:</span>
                <span class="tooltip-value" id="tooltip-type"></span>
            </div>
            <div class="tooltip-row">
                <span class="tooltip-label">Size:</span>
                <span class="tooltip-value" id="tooltip-size"></span>
            </div>
            <div class="tooltip-row">
                <span class="tooltip-label">Lines:</span>
                <span class="tooltip-value" id="tooltip-lines"></span>
            </div>
            <div class="tooltip-row">
                <span class="tooltip-label">Imports:</span>
                <span class="tooltip-value" id="tooltip-imports"></span>
            </div>
        </div>
        
        <div class="stats-bar">
            <div class="stat-item">
                <span class="stat-label">Total Files:</span>
                <span class="stat-value" id="stat-files">0</span>
            </div>
            <div class="stat-item">
                <span class="stat-label">Total Folders:</span>
                <span class="stat-value" id="stat-folders">0</span>
            </div>
            <div class="stat-item">
                <span class="stat-label">Dependencies:</span>
                <span class="stat-value" id="stat-deps">0</span>
            </div>
            <div class="stat-item">
                <span class="stat-label">Total Lines:</span>
                <span class="stat-value" id="stat-lines">0</span>
            </div>
        </div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        const treeData = ${treeData};
        const linksData = ${linksData};
        
        let currentView = 'tree';
        let expandedFolders = new Set();
        let selectedNode = null;
        let zoom = 1;
        let panX = 0, panY = 0;
        let isDragging = false;
        let lastX, lastY;

        // Statistics
        let stats = { files: 0, folders: 0, lines: 0 };
        
        function countStats(node) {
            if (node.type === 'folder') {
                stats.folders++;
                if (node.children) {
                    node.children.forEach(countStats);
                }
            } else {
                stats.files++;
                stats.lines += node.lines || 0;
            }
        }
        countStats(treeData);
        
        document.getElementById('stat-files').textContent = stats.files;
        document.getElementById('stat-folders').textContent = stats.folders;
        document.getElementById('stat-deps').textContent = linksData.length;
        document.getElementById('stat-lines').textContent = stats.lines.toLocaleString();

        // File tree rendering
        function renderFileTree(node, container, level = 0) {
            const isFolder = node.type === 'folder';
            const isExpanded = expandedFolders.has(node.id);
            
            const itemDiv = document.createElement('div');
            itemDiv.className = isFolder ? 'tree-folder' : 'tree-file';
            
            const itemContent = document.createElement('div');
            itemContent.className = 'tree-item';
            itemContent.style.paddingLeft = (16 + level * 16) + 'px';
            
            const icon = document.createElement('span');
            icon.className = 'icon';
            
            if (isFolder) {
                icon.innerHTML = isExpanded ? '📂' : '📁';
                itemContent.classList.toggle('expanded', isExpanded);
            } else {
                icon.innerHTML = getFileIcon(node.extension);
            }
            
            const name = document.createElement('span');
            name.className = 'name';
            name.textContent = node.name;
            
            itemContent.appendChild(icon);
            itemContent.appendChild(name);
            
            if (!isFolder && node.lines) {
                const badge = document.createElement('span');
                badge.className = 'badge';
                badge.textContent = node.lines + ' lines';
                itemContent.appendChild(badge);
            }
            
            itemContent.addEventListener('click', () => {
                if (isFolder) {
                    if (isExpanded) {
                        expandedFolders.delete(node.id);
                    } else {
                        expandedFolders.add(node.id);
                    }
                    refreshFileTree();
                } else {
                    selectedNode = node;
                    document.querySelectorAll('.tree-item').forEach(el => el.classList.remove('selected'));
                    itemContent.classList.add('selected');
                    highlightNodeInGraph(node);
                }
            });
            
            itemContent.addEventListener('dblclick', () => {
                if (!isFolder) {
                    vscode.postMessage({ command: 'openFile', filePath: node.path });
                }
            });
            
            itemDiv.appendChild(itemContent);
            
            if (isFolder && node.children && isExpanded) {
                const childrenContainer = document.createElement('div');
                childrenContainer.className = 'tree-children';
                node.children.forEach(child => renderFileTree(child, childrenContainer, level + 1));
                itemDiv.appendChild(childrenContainer);
            }
            
            container.appendChild(itemDiv);
        }
        
        function getFileIcon(ext) {
            const icons = {
                '.ts': '📘',
                '.tsx': '⚛️',
                '.js': '📒',
                '.jsx': '⚛️',
                '.py': '🐍',
                '.java': '☕',
                '.cs': '🔷',
                '.cpp': '⚙️',
                '.c': '⚙️',
                '.go': '🔵',
                '.rs': '🦀',
                '.vue': '💚',
                '.svelte': '🧡',
                '.json': '📋',
                '.md': '📝',
                '.css': '🎨',
                '.scss': '🎨',
                '.html': '🌐'
            };
            return icons[ext] || '📄';
        }
        
        function refreshFileTree() {
            const container = document.getElementById('file-tree');
            container.innerHTML = '';
            if (treeData.children) {
                treeData.children.forEach(child => renderFileTree(child, container));
            }
        }

        // Search functionality
        document.getElementById('search-input').addEventListener('input', (e) => {
            const query = e.target.value.toLowerCase();
            filterTree(query);
        });

        function filterTree(query) {
            const items = document.querySelectorAll('.tree-item');
            items.forEach(item => {
                const name = item.querySelector('.name').textContent.toLowerCase();
                const parent = item.closest('.tree-folder, .tree-file');
                if (query === '' || name.includes(query)) {
                    parent.style.display = '';
                } else {
                    parent.style.display = 'none';
                }
            });
        }

        // Graph visualization
        function renderGraph() {
            const container = document.getElementById('graph-container');
            container.innerHTML = '';
            
            const width = container.clientWidth;
            const height = container.clientHeight;
            
            // Create SVG
            const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            svg.setAttribute('width', width);
            svg.setAttribute('height', height);
            container.appendChild(svg);
            
            // Create main group for zoom/pan
            const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
            g.setAttribute('id', 'main-group');
            svg.appendChild(g);
            
            // Flatten tree to nodes
            const nodes = [];
            const nodeMap = new Map();
            
            function flattenTree(node, depth = 0, parentY = 0) {
                const x = depth * 180 + 100;
                const y = parentY;
                
                nodes.push({
                    ...node,
                    x,
                    y,
                    depth
                });
                nodeMap.set(node.path, nodes[nodes.length - 1]);
                
                if (node.children) {
                    let childY = y - (node.children.length - 1) * 30;
                    node.children.forEach((child, i) => {
                        flattenTree(child, depth + 1, childY + i * 60);
                    });
                }
            }
            
            flattenTree(treeData, 0, height / 2);
            
            // Draw links (tree structure)
            nodes.forEach(node => {
                if (node.children) {
                    node.children.forEach(child => {
                        const childNode = nodeMap.get(child.path);
                        if (childNode) {
                            const link = document.createElementNS('http://www.w3.org/2000/svg', 'path');
                            const midX = (node.x + childNode.x) / 2;
                            link.setAttribute('d', \`M \${node.x} \${node.y} C \${midX} \${node.y}, \${midX} \${childNode.y}, \${childNode.x} \${childNode.y}\`);
                            link.setAttribute('class', 'link');
                            link.setAttribute('data-source', node.path);
                            link.setAttribute('data-target', childNode.path);
                            g.appendChild(link);
                        }
                    });
                }
            });
            
            // Draw dependency links
            linksData.forEach(link => {
                const source = nodeMap.get(link.source);
                const target = nodeMap.get(link.target);
                if (source && target) {
                    const depLink = document.createElementNS('http://www.w3.org/2000/svg', 'path');
                    const midX = (source.x + target.x) / 2;
                    const midY = (source.y + target.y) / 2 - 50;
                    depLink.setAttribute('d', \`M \${source.x} \${source.y} Q \${midX} \${midY}, \${target.x} \${target.y}\`);
                    depLink.setAttribute('class', 'link');
                    depLink.setAttribute('stroke', '#007acc');
                    depLink.setAttribute('stroke-dasharray', '5,5');
                    depLink.setAttribute('data-source', link.source);
                    depLink.setAttribute('data-target', link.target);
                    g.appendChild(depLink);
                }
            });
            
            // Draw nodes
            nodes.forEach(node => {
                const nodeGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
                nodeGroup.setAttribute('class', 'node');
                nodeGroup.setAttribute('transform', \`translate(\${node.x}, \${node.y})\`);
                nodeGroup.setAttribute('data-path', node.path);
                
                const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
                circle.setAttribute('r', node.type === 'folder' ? 12 : 8);
                circle.setAttribute('fill', getNodeColor(node));
                circle.setAttribute('stroke', '#333');
                
                const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
                text.setAttribute('x', 16);
                text.setAttribute('y', 4);
                text.textContent = node.name.length > 20 ? node.name.substring(0, 17) + '...' : node.name;
                
                nodeGroup.appendChild(circle);
                nodeGroup.appendChild(text);
                
                nodeGroup.addEventListener('click', () => {
                    if (node.type === 'file') {
                        vscode.postMessage({ command: 'openFile', filePath: node.path });
                    }
                });
                
                nodeGroup.addEventListener('mouseenter', (e) => showTooltip(e, node));
                nodeGroup.addEventListener('mouseleave', hideTooltip);
                
                g.appendChild(nodeGroup);
            });
            
            // Pan and zoom
            svg.addEventListener('mousedown', (e) => {
                isDragging = true;
                lastX = e.clientX;
                lastY = e.clientY;
            });
            
            svg.addEventListener('mousemove', (e) => {
                if (isDragging) {
                    panX += e.clientX - lastX;
                    panY += e.clientY - lastY;
                    lastX = e.clientX;
                    lastY = e.clientY;
                    updateTransform();
                }
            });
            
            svg.addEventListener('mouseup', () => isDragging = false);
            svg.addEventListener('mouseleave', () => isDragging = false);
            
            svg.addEventListener('wheel', (e) => {
                e.preventDefault();
                const delta = e.deltaY > 0 ? 0.9 : 1.1;
                zoom *= delta;
                zoom = Math.max(0.1, Math.min(3, zoom));
                updateTransform();
            });
        }
        
        function getNodeColor(node) {
            if (node.type === 'folder') return '#ffb74d';
            const ext = node.extension;
            if (['.ts', '.tsx', '.js', '.jsx'].includes(ext)) return '#4fc3f7';
            if (ext === '.py') return '#81c784';
            if (['.java', '.cs'].includes(ext)) return '#ba68c8';
            return '#e57373';
        }
        
        function updateTransform() {
            const g = document.getElementById('main-group');
            if (g) {
                g.setAttribute('transform', \`translate(\${panX}, \${panY}) scale(\${zoom})\`);
            }
        }
        
        function highlightNodeInGraph(node) {
            document.querySelectorAll('.node circle').forEach(circle => {
                circle.style.strokeWidth = '2px';
            });
            
            const nodeEl = document.querySelector(\`.node[data-path="\${node.path}"] circle\`);
            if (nodeEl) {
                nodeEl.style.strokeWidth = '4px';
                nodeEl.style.stroke = '#007acc';
            }
        }
        
        function showTooltip(e, node) {
            const tooltip = document.getElementById('tooltip');
            tooltip.classList.add('visible');
            
            document.getElementById('tooltip-title').textContent = node.name;
            document.getElementById('tooltip-type').textContent = node.type === 'folder' ? 'Folder' : node.extension;
            document.getElementById('tooltip-size').textContent = node.size ? formatBytes(node.size) : 'N/A';
            document.getElementById('tooltip-lines').textContent = node.lines || 'N/A';
            document.getElementById('tooltip-imports').textContent = node.imports ? node.imports.length : 0;
            
            tooltip.style.left = (e.clientX + 10) + 'px';
            tooltip.style.top = (e.clientY + 10) + 'px';
        }
        
        function hideTooltip() {
            document.getElementById('tooltip').classList.remove('visible');
        }
        
        function formatBytes(bytes) {
            if (bytes < 1024) return bytes + ' B';
            if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
            return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
        }

        // View toggle
        document.getElementById('tree-view-btn').addEventListener('click', () => {
            currentView = 'tree';
            document.getElementById('tree-view-btn').classList.add('active');
            document.getElementById('graph-view-btn').classList.remove('active');
            document.querySelector('.sidebar').style.display = 'flex';
            renderGraph();
        });
        
        document.getElementById('graph-view-btn').addEventListener('click', () => {
            currentView = 'graph';
            document.getElementById('graph-view-btn').classList.add('active');
            document.getElementById('tree-view-btn').classList.remove('active');
            document.querySelector('.sidebar').style.display = 'none';
            renderGraph();
        });

        // Zoom controls
        document.getElementById('zoom-in').addEventListener('click', () => {
            zoom = Math.min(3, zoom * 1.2);
            updateTransform();
        });
        
        document.getElementById('zoom-out').addEventListener('click', () => {
            zoom = Math.max(0.1, zoom / 1.2);
            updateTransform();
        });
        
        document.getElementById('zoom-reset').addEventListener('click', () => {
            zoom = 1;
            panX = 0;
            panY = 0;
            updateTransform();
        });

        // Expand/Collapse all
        document.getElementById('expand-all-btn').addEventListener('click', () => {
            function expandAll(node) {
                if (node.type === 'folder') {
                    expandedFolders.add(node.id);
                    if (node.children) node.children.forEach(expandAll);
                }
            }
            expandAll(treeData);
            refreshFileTree();
        });
        
        document.getElementById('collapse-all-btn').addEventListener('click', () => {
            expandedFolders.clear();
            refreshFileTree();
        });

        // Refresh button
        document.getElementById('refresh-btn').addEventListener('click', () => {
            vscode.postMessage({ command: 'refresh' });
        });

        // Initial render
        expandedFolders.add(treeData.id);
        refreshFileTree();
        renderGraph();
        
        // Handle window resize
        window.addEventListener('resize', () => {
            renderGraph();
        });
    </script>
</body>
</html>`;
    }

    dispose(): void {
        if (this.panel) {
            this.panel.dispose();
        }
        this.disposables.forEach(d => d.dispose());
    }
}
