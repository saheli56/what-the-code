import * as vscode from 'vscode';

export class VisualizerActionsProvider implements vscode.TreeDataProvider<VisualizerActionItem>, vscode.Disposable {
    private _onDidChangeTreeData: vscode.EventEmitter<VisualizerActionItem | undefined | null | void> = new vscode.EventEmitter<VisualizerActionItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<VisualizerActionItem | undefined | null | void> = this._onDidChangeTreeData.event;

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    dispose(): void {
        this._onDidChangeTreeData.dispose();
    }

    getTreeItem(element: VisualizerActionItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: VisualizerActionItem): Thenable<VisualizerActionItem[]> {
        if (element) {
            return Promise.resolve([]);
        }

        const items: VisualizerActionItem[] = [
            new VisualizerActionItem(
                '🌳 Open Code Visualizer',
                'Visualize your codebase structure and dependencies',
                vscode.TreeItemCollapsibleState.None,
                {
                    command: 'what-the-code.openCodeVisualizer',
                    title: 'Open Code Visualizer'
                }
            ),
            new VisualizerActionItem(
                '📊 Features',
                '',
                vscode.TreeItemCollapsibleState.None
            ),
            new VisualizerActionItem(
                '   • Interactive tree view',
                'See your project structure in a visual tree',
                vscode.TreeItemCollapsibleState.None
            ),
            new VisualizerActionItem(
                '   • Dependency graph',
                'View file imports and connections',
                vscode.TreeItemCollapsibleState.None
            ),
            new VisualizerActionItem(
                '   • File statistics',
                'Lines of code, file sizes, and more',
                vscode.TreeItemCollapsibleState.None
            ),
            new VisualizerActionItem(
                '   • Click to open files',
                'Double-click any file to open it',
                vscode.TreeItemCollapsibleState.None
            )
        ];

        return Promise.resolve(items);
    }
}

export class VisualizerActionItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly description: string,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly command?: vscode.Command
    ) {
        super(label, collapsibleState);
        this.tooltip = this.description || this.label;
        
        if (this.label.startsWith('🌳')) {
            this.iconPath = new vscode.ThemeIcon('type-hierarchy');
        } else if (this.label.startsWith('📊')) {
            this.iconPath = new vscode.ThemeIcon('graph');
        } else if (this.label.includes('•')) {
            this.iconPath = new vscode.ThemeIcon('circle-small-filled');
        }
    }

    contextValue = 'visualizerAction';
}
