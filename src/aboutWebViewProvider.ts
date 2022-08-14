import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

/**
 * Provides the WebView for the About section.
 */
export class AboutWebviewProvider implements vscode.Disposable, vscode.WebviewViewProvider {
    // #region Private Properties

    /** The extension context we were initialized with. */
    private readonly context: vscode.ExtensionContext;

    // #endregion

    // #region Constructors

    /**
     * Creates a new instance of the WebView provider for the About section.
     *
     * @param context The context that describes this extension.
     */
    public constructor(context: vscode.ExtensionContext) {
        this.context = context;

        context.subscriptions.push(vscode.window.registerWebviewViewProvider("magnus-about", this));
    }

    /** @inheritdoc */
    public dispose(): void {
        // Intentionally left blank.
    }

    // #endregion

    // #region WebviewViewProvider

    /** @inheritdoc */
    public async resolveWebviewView(webviewView: vscode.WebviewView, _context: vscode.WebviewViewResolveContext<unknown>, _token: vscode.CancellationToken): Promise<void> {
        // Enable JavaScript and allow image loading from our extension path.
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                this.context.extensionUri
            ]
        };

        // Load the contents of the about page.
        const htmlDiskPath = path.join(this.context.extensionPath, "resources", "about.html");
        let html = (await fs.promises.readFile(htmlDiskPath)).toString("utf8");

        // Replace img references to "./" files.
        html = html.replace(/(<img\s+src=['"])(\.\/[^'"]+)/ig, (_, imgTag, imgPath) => {
            const imgUri = vscode.Uri.file(path.join(this.context.extensionPath, "resources", imgPath.substring(2)));
            const webUri = webviewView.webview.asWebviewUri(imgUri);

            return `${imgTag}${webUri.toString()}`;
        });

        // Add message handlers.
        webviewView.webview.onDidReceiveMessage(message => {
            if (message.command === "read-documentation") {
                vscode.env.openExternal(vscode.Uri.parse("https://www.triumph.tech"));
            }
            else if (message.command === "report-issue") {
                vscode.env.openExternal(vscode.Uri.parse("https://www.triumph.tech"));
            }
        });

        webviewView.webview.html = html;
    }
}
