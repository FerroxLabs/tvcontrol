import { register } from '../router.js';
import { ClassifiedError, CATEGORIES } from '../../errors.js';
import * as core from '../../core/ui.js';

function _arg(condition, message) {
  if (!condition) throw new ClassifiedError(CATEGORIES.INVALID_ARGUMENT, message);
}

register('ui', {
  description: 'UI automation tools (click, keyboard, hover, scroll, find, eval, type, panel, fullscreen, mouse)',
  subcommands: new Map([
    ['click', {
      description: 'Click a UI element',
      options: {
        by: { type: 'string', short: 'b', description: 'Selector: aria-label, data-name, text, class-contains' },
        value: { type: 'string', short: 'v', description: 'Value to match' },
      },
      handler: (opts) => core.click({ by: opts.by || 'text', value: opts.value }),
    }],
    ['keyboard', {
      description: 'Press a keyboard key or shortcut',
      usage: '<key> [--ctrl] [--shift] [--alt] [--meta]',
      options: {
        ctrl: { type: 'boolean', description: 'Hold Ctrl' },
        shift: { type: 'boolean', description: 'Hold Shift' },
        alt: { type: 'boolean', description: 'Hold Alt' },
        meta: { type: 'boolean', description: 'Hold Meta/Cmd' },
      },
      handler: (opts, positionals) => {
        _arg(positionals[0], 'Key required. Usage: tv ui keyboard Escape');
        const modifiers = [];
        if (opts.ctrl) modifiers.push('ctrl');
        if (opts.shift) modifiers.push('shift');
        if (opts.alt) modifiers.push('alt');
        if (opts.meta) modifiers.push('meta');
        return core.keyboard({ key: positionals[0], modifiers: modifiers.length > 0 ? modifiers : undefined });
      },
    }],
    ['hover', {
      description: 'Hover over a UI element',
      options: {
        by: { type: 'string', short: 'b', description: 'Selector: aria-label, data-name, text, class-contains' },
        value: { type: 'string', short: 'v', description: 'Value to match' },
      },
      handler: (opts) => core.hover({ by: opts.by || 'text', value: opts.value }),
    }],
    ['scroll', {
      description: 'Scroll the chart',
      usage: '[direction] [--amount <px>]',
      options: {
        amount: { type: 'string', short: 'a', description: 'Scroll amount in pixels (default 300)' },
      },
      handler: (opts, positionals) => {
        const direction = positionals[0] || 'down';
        return core.scroll({ direction, amount: opts.amount ? Number(opts.amount) : undefined });
      },
    }],
    ['find', {
      description: 'Find UI elements by text, aria-label, or CSS selector',
      usage: '<query> [--strategy <text|aria-label|css>]',
      options: {
        strategy: { type: 'string', short: 's', description: 'Search strategy: text, aria-label, css' },
      },
      handler: (opts, positionals) => {
        _arg(positionals[0], 'Query required. Usage: tv ui find "Indicators"');
        return core.findElement({ query: positionals.join(' '), strategy: opts.strategy });
      },
    }],
    ['eval', {
      description: 'Execute JavaScript in TradingView page context',
      usage: '<expression>',
      handler: (opts, positionals) => {
        _arg(positionals[0], 'Expression required. Usage: tv ui eval "1+1"');
        return core.uiEvaluate({ expression: positionals.join(' ') });
      },
    }],
    ['type', {
      description: 'Type text into focused input',
      usage: '<text>',
      handler: (opts, positionals) => {
        _arg(positionals[0], 'Text required. Usage: tv ui type "hello"');
        return core.typeText({ text: positionals.join(' ') });
      },
    }],
    ['panel', {
      description: 'Open/close/toggle a panel',
      usage: '<panel> [open|close|toggle]',
      handler: (opts, positionals) => {
        _arg(positionals[0], 'Usage: tv ui panel pine-editor open');
        return core.openPanel({ panel: positionals[0], action: positionals[1] || 'toggle' });
      },
    }],
    ['fullscreen', {
      description: 'Toggle fullscreen mode',
      handler: () => core.fullscreen(),
    }],
    ['mouse', {
      description: 'Click at x,y coordinates',
      usage: '<x> <y> [--right] [--double]',
      options: {
        right: { type: 'boolean', description: 'Right click' },
        double: { type: 'boolean', description: 'Double click' },
      },
      handler: (opts, positionals) => {
        _arg(positionals.length >= 2, 'Usage: tv ui mouse 400 400 [--right] [--double]');
        return core.mouseClick({
          x: Number(positionals[0]),
          y: Number(positionals[1]),
          button: opts.right ? 'right' : 'left',
          double_click: opts.double,
        });
      },
    }],
  ]),
});
