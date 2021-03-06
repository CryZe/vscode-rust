import * as cp from 'child_process';

import * as fs from 'fs';

import {
    DocumentFormattingEditProvider,
    DocumentRangeFormattingEditProvider,
    ExtensionContext,
    Range,
    TextDocument,
    TextEdit,
    Uri,
    languages,
    window
} from 'vscode';
import { Configuration } from '../configuration/Configuration';
import { getDocumentFilter } from '../configuration/mod';
import { FileSystem } from '../file_system/FileSystem';

const ansiRegex = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;

interface RustFmtDiff {
    startLine: number;
    newLines: string[];
    removedLines: number;
}

export class FormattingManager implements DocumentFormattingEditProvider, DocumentRangeFormattingEditProvider {
    private configuration: Configuration;

    private newFormatRegex: RegExp = /^Diff in (.*) at line (\d+):$/;

    public static async create(context: ExtensionContext, configuration: Configuration): Promise<FormattingManager | undefined> {
        const rustfmtPath: string | undefined = await FileSystem.findExecutablePath(configuration.getRustfmtPath());
        if (rustfmtPath === undefined) {
            return undefined;
        }
        return new FormattingManager(context, configuration);
    }

    public provideDocumentFormattingEdits(document: TextDocument): Thenable<TextEdit[]> {
        return this.formattingEdits(document);
    }

    public provideDocumentRangeFormattingEdits(document: TextDocument, range: Range): Thenable<TextEdit[]> {
        return this.formattingEdits(document, range);
    }

    /**
     * To create an instance of the class use the method `create`
     * @param context The extension context
     * @param configuration The configuration
     */
    private constructor(context: ExtensionContext, configuration: Configuration) {
        this.configuration = configuration;
        context.subscriptions.push(
            languages.registerDocumentFormattingEditProvider(
                getDocumentFilter(),
                this
            ),
            languages.registerDocumentRangeFormattingEditProvider(
                getDocumentFilter(),
                this
            )
        );
    }

    private formattingEdits(document: TextDocument, range?: Range): Thenable<TextEdit[]> {
        return new Promise((resolve, reject) => {
            const fileName = document.fileName + '.fmt';
            fs.writeFileSync(fileName, document.getText());

            const args = ['--skip-children', '--write-mode=diff'];
            if (range !== undefined) {
                args.push('--file-lines',
                    `[{"file":"${fileName}","range":[${range.start.line + 1}, ${range.end.line + 1}]}]`);
            } else {
                args.push(fileName);
            }
            const env = Object.assign({ TERM: 'xterm' }, process.env);
            cp.execFile(this.configuration.getRustfmtPath(), args, { env: env }, (err, stdout, stderr) => {
                try {
                    if (err && (<any>err).code === 'ENOENT') {
                        window.showInformationMessage('The "rustfmt" command is not available. Make sure it is installed.');
                        return resolve([]);
                    }

                    // rustfmt will return with exit code 3 when it encounters code that could not
                    // be automatically formatted. However, it will continue to format the rest of the file.
                    // New releases will return exit code 4 when the write mode is diff and a valid diff is provided.
                    // For these reasons, if the exit code is 1 or 2, then it should be treated as an error.
                    const hasFatalError = (err && (err as any).code < 3);

                    if ((err || stderr.length) && hasFatalError) {
                        window.setStatusBarMessage('$(alert) Cannot format due to syntax errors', 5000);
                        return reject();
                    }

                    return resolve(this.parseDiff(document.uri, stdout));
                } catch (e) {
                    reject(e);
                } finally {
                    fs.unlinkSync(fileName);
                }
            });
        });
    }

    private cleanDiffLine(line: string): string {
        if (line.endsWith('\u23CE')) {
            return line.slice(1, -1) + '\n';
        }

        return line.slice(1);
    }

    private stripColorCodes(input: string): string {
        return input.replace(ansiRegex, '');
    }

    private parseDiffOldFormat(fileToProcess: Uri, diff: string): RustFmtDiff[] {
        const patches: RustFmtDiff[] = [];
        let currentPatch: RustFmtDiff | undefined = undefined;
        let currentFile: Uri | undefined = undefined;

        for (const line of diff.split(/\n/)) {
            if (line.startsWith('Diff of')) {
                currentFile = Uri.file(line.slice('Diff of '.length, -1));
            }

            if (!currentFile) {
                continue;
            }

            if (currentFile.toString() !== fileToProcess.toString() + '.fmt') {
                continue;
            }

            if (line.startsWith('Diff at line')) {
                if (currentPatch != null) {
                    patches.push(currentPatch);
                }

                currentPatch = {
                    startLine: parseInt(line.slice('Diff at line'.length), 10),
                    newLines: [],
                    removedLines: 0
                };
            } else if (currentPatch !== undefined) {
                if (line.startsWith('+')) {
                    currentPatch.newLines.push(this.cleanDiffLine(line));
                } else if (line.startsWith('-')) {
                    currentPatch.removedLines += 1;
                } else if (line.startsWith(' ')) {
                    currentPatch.newLines.push(this.cleanDiffLine(line));
                    currentPatch.removedLines += 1;
                }
            }
        }

        if (currentPatch) {
            patches.push(currentPatch);
        }

        return patches;
    }

    private parseDiffNewFormat(fileToProcess: Uri, diff: string): RustFmtDiff[] {
        const patches: RustFmtDiff[] = [];
        let currentPatch: RustFmtDiff | undefined = undefined;
        let currentFile: Uri | undefined = undefined;

        for (const line of diff.split(/\n/)) {
            if (line.startsWith('Diff in')) {
                const matches = this.newFormatRegex.exec(line);

                if (!matches) {
                    continue;
                }

                // Filter out malformed lines
                if (matches.length !== 3) {
                    continue;
                }

                // If we begin a new diff while already building one, push it as its now complete
                if (currentPatch !== undefined) {
                    patches.push(currentPatch);
                }

                currentFile = Uri.file(matches[1]);
                currentPatch = {
                    startLine: parseInt(matches[2], 10),
                    newLines: [],
                    removedLines: 0
                };
            }

            // We haven't managed to figure out what file we're diffing yet, this shouldn't happen.
            // Probably a malformed diff.
            if (!currentFile) {
                continue;
            }

            if (currentFile.toString() !== fileToProcess.toString() + '.fmt') {
                continue;
            }

            if (!currentPatch) {
                continue;
            }

            if (line.startsWith('+')) {
                currentPatch.newLines.push(this.cleanDiffLine(line));
            } else if (line.startsWith('-')) {
                currentPatch.removedLines += 1;
            } else if (line.startsWith(' ')) {
                currentPatch.newLines.push(this.cleanDiffLine(line));
                currentPatch.removedLines += 1;
            }
        }

        // We've reached the end of the data, push the current patch if we were building one
        if (currentPatch) {
            patches.push(currentPatch);
        }

        return patches;
    }

    private parseDiff(fileToProcess: Uri, diff: string): TextEdit[] {
        diff = this.stripColorCodes(diff);

        let patches: RustFmtDiff[] = [];
        const oldFormat = diff.startsWith('Diff of');
        if (oldFormat) {
            patches = this.parseDiffOldFormat(fileToProcess, diff);
        } else {
            patches = this.parseDiffNewFormat(fileToProcess, diff);
        }

        let cummulativeOffset = 0;
        const textEdits = patches.map(patch => {
            const newLines = patch.newLines;
            const removedLines = patch.removedLines;

            const startLine = patch.startLine - 1 + cummulativeOffset;
            const endLine = removedLines === 0 ? startLine : startLine + removedLines - 1;
            const range = new Range(startLine, 0, endLine, Number.MAX_SAFE_INTEGER);

            cummulativeOffset += (removedLines - newLines.length);

            const lastLineIndex = newLines.length - 1;
            newLines[lastLineIndex] = newLines[lastLineIndex].replace('\n', '');

            return TextEdit.replace(range, newLines.join(''));
        });
        return textEdits;
    }
}
