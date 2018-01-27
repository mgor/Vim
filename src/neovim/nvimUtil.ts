import { spawn } from 'child_process';
import { attach } from 'promised-neovim-client';
import * as vscode from 'vscode';

import { configuration } from '../configuration/configuration';
import { ModeName } from '../mode/mode';
import { Register, RegisterMode } from '../register/register';
import { TextEditor } from '../textEditor';
import { Position } from './../common/motion/position';
import { VimState } from './../state/vimState';

export class Neovim {
  static async initNvim(vimState: VimState) {
    const proc = spawn(configuration.neovimPath, ['-u', 'NONE', '-N', '--embed'], {
      cwd: __dirname,
    });
    proc.on('error', function(err) {
      console.log(err);
      vscode.window.showErrorMessage('Unable to setup neovim instance! Check your path.');
      configuration.enableNeovim = false;
    });
    vimState.nvim = await attach(proc.stdin, proc.stdout);
  }

  // Data flows from VS to Vim
  static async syncVSToVim(vimState: VimState) {
    const nvim = vimState.nvim;
    const buf = await nvim.getCurrentBuf();
    if (configuration.expandtab) {
      await vscode.commands.executeCommand('editor.action.indentationToTabs');
    }

    await nvim.setOption('gdefault', configuration.substituteGlobalFlag === true);
    await buf.setLines(0, -1, true, TextEditor.getText().split('\n'));
    const [rangeStart, rangeEnd] = [
      Position.EarlierOf(vimState.cursorPosition, vimState.cursorStartPosition),
      Position.LaterOf(vimState.cursorPosition, vimState.cursorStartPosition),
    ];
    await nvim.callFunction('setpos', [
      '.',
      [0, vimState.cursorPosition.line + 1, vimState.cursorPosition.character, false],
    ]);
    await nvim.callFunction('setpos', ["'<", [0, rangeStart.line + 1, rangeEnd.character, false]]);
    await nvim.callFunction('setpos', ["'>", [0, rangeEnd.line + 1, rangeEnd.character, false]]);
    for (const mark of vimState.historyTracker.getMarks()) {
      await nvim.callFunction('setpos', [
        `'${mark.name}`,
        [0, mark.position.line + 1, mark.position.character, false],
      ]);
    }

    // We only copy over " register for now, due to our weird handling of macros.
    let reg = await Register.get(vimState);
    let vsRegTovimReg = [undefined, 'c', 'l', 'b'];
    await nvim.callFunction('setreg', [
      '"',
      reg.text as string,
      vsRegTovimReg[vimState.effectiveRegisterMode] as string,
    ]);
  }

  // Data flows from Vim to VS
  static async syncVimToVs(vimState: VimState) {
    const nvim = vimState.nvim;
    const buf = await nvim.getCurrentBuf();
    const lines = await buf.getLines(0, -1, false);

    // one Windows, lines that went to nvim and back have a '\r' at the end,
    // which causes the issues exhibited in #1914
    const fixedLines =
      process.platform === 'win32' ? lines.map((line, index) => line.replace(/\r$/, '')) : lines;

    await TextEditor.replace(
      new vscode.Range(
        0,
        0,
        TextEditor.getLineCount() - 1,
        TextEditor.getLineMaxColumn(TextEditor.getLineCount() - 1)
      ),
      fixedLines.join('\n')
    );

    console.log(`${lines.length} lines in nvime but ${TextEditor.getLineCount()} in editor.`);

    let [row, character] = ((await nvim.callFunction('getpos', ['.'])) as Array<number>).slice(
      1,
      3
    );
    vimState.editor.selection = new vscode.Selection(
      new Position(row - 1, character),
      new Position(row - 1, character)
    );

    if (configuration.expandtab) {
      await vscode.commands.executeCommand('editor.action.indentationToSpaces');
    }
    // We're only syncing back the default register for now, due to the way we could
    // be storing macros in registers.
    const vimRegToVsReg = {
      v: RegisterMode.CharacterWise,
      V: RegisterMode.LineWise,
      '\x16': RegisterMode.BlockWise,
    };
    vimState.currentRegisterMode =
      vimRegToVsReg[(await nvim.callFunction('getregtype', ['"'])) as string];
    Register.put((await nvim.callFunction('getreg', ['"'])) as string, vimState);
  }

  static async command(vimState: VimState, command: string) {
    const nvim = vimState.nvim;
    await this.syncVSToVim(vimState);
    command = ':' + command + '\n';
    command = command.replace('<', '<lt>');

    await nvim.input(command);
    if ((await nvim.getMode()).blocking) {
      await nvim.input('<esc>');
    }
    await this.syncVimToVs(vimState);

    return;
  }

  static async input(vimState: VimState, keys: string) {
    const nvim = vimState.nvim;
    await this.syncVSToVim(vimState);
    await nvim.input(keys);
    await this.syncVimToVs(vimState);

    return;
  }
}
