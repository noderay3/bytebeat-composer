import { closeBrackets } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentLess, insertNewline, redo } from '@codemirror/commands';
import { javascript } from '@codemirror/lang-javascript';
import { bracketMatching, foldGutter, indentUnit, syntaxHighlighting } from '@codemirror/language';
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search';
import { EditorState, StateEffect, StateField } from '@codemirror/state';
import { Decoration, highlightActiveLine, highlightSpecialChars, EditorView, keymap, lineNumbers }
	from '@codemirror/view';
import { tagHighlighter, tags } from '@lezer/highlight';

// Effect/field that lets the explorer paint a transient mark on a source
// range — used to highlight the subtree currently hovered in the tree panel.
const setExplorerHighlight = StateEffect.define();
const explorerHighlightField = StateField.define({
	create() {
		return Decoration.none;
	},
	update(deco, tr) {
		deco = deco.map(tr.changes);
		for(const e of tr.effects) {
			if(e.is(setExplorerHighlight)) {
				if(e.value === null || e.value.from >= e.value.to) {
					deco = Decoration.none;
				} else {
					deco = Decoration.set([
						Decoration.mark({ class: 'cm-explorer-hover' }).range(e.value.from, e.value.to)
					]);
				}
			}
		}
		return deco;
	},
	provide: f => EditorView.decorations.from(f)
});

// Effect/field for live activity highlight — the explorer's live monitor
// pushes the current set of "active" source ranges every animation frame.
// Mirrors Strudel's mini-notation highlight pattern: anchored ranges survive
// user edits via CodeMirror's automatic Decoration remapping, and a derived
// outline decoration is painted from the active set. Color comes from the
// same HSL mapping the tree node uses, so the editor + tree pulse together.
const setActiveRanges = StateEffect.define();
const activeRangesField = StateField.define({
	create() {
		return Decoration.none;
	},
	update(deco, tr) {
		deco = deco.map(tr.changes);
		for(const e of tr.effects) {
			if(e.is(setActiveRanges)) {
				const ranges = e.value || [];
				if(ranges.length === 0) {
					deco = Decoration.none;
				} else {
					// Sort by from + length — Decoration.set wants ascending order.
					const sorted = ranges
						.filter(r => r && r.from < r.to)
						.sort((a, b) => a.from - b.from || a.to - b.to);
					deco = Decoration.set(sorted.map(r =>
						Decoration.mark({
							class: 'cm-explorer-active',
							attributes: { style: `outline:1.5px solid ${ r.color || '#4af' };outline-offset:-1px;border-radius:2px;` }
						}).range(r.from, r.to)
					), true);
				}
			}
		}
		return deco;
	},
	provide: f => EditorView.decorations.from(f)
});

const editorView = initValue => new EditorView({
	parent: document.getElementById('editor-container'),
	state: EditorState.create({
		doc: initValue,
		extensions: [
			bracketMatching(),
			closeBrackets(),
			EditorState.tabSize.of('3'),
			EditorView.lineWrapping,
			EditorView.updateListener.of(view => {
				if(view.docChanged) {
					const src = view.state.doc.toString();
					globalThis.bytebeat.sendData({ setFunction: src });
					if(globalThis.bytebeat.explorer) {
						globalThis.bytebeat.explorer.onEditorChange(src);
					}
				}
			}),
			activeRangesField,
			explorerHighlightField,
			foldGutter(),
			highlightActiveLine(),
			highlightSelectionMatches(),
			highlightSpecialChars(),
			history(),
			indentUnit.of('\t'),
			javascript(),
			keymap.of([
				{ key: 'Ctrl-Y', run: redo },
				{ key: 'Enter', run: insertNewline },
				{
					key: 'Tab',
					run: view => view.dispatch(view.state.replaceSelection('\t')) || true,
					shift: indentLess
				},
				...historyKeymap,
				...searchKeymap,
				...defaultKeymap
			]),
			lineNumbers(),
			syntaxHighlighting(tagHighlighter([
				{ tag: tags.bool, class: 'tok-bool' },
				{ tag: tags.comment, class: 'tok-comment' },
				{ tag: tags.definition(tags.variableName), class: 'tok-definition' },
				{ tag: tags.function(tags.variableName), class: 'tok-function' },
				{ tag: tags.function(tags.propertyName), class: 'tok-function' },
				{ tag: tags.keyword, class: 'tok-keyword' },
				{ tag: tags.number, class: 'tok-number' },
				{ tag: tags.operator, class: 'tok-operator' },
				{ tag: tags.propertyName, class: 'tok-property' },
				{ tag: tags.punctuation, class: 'tok-punctuation' },
				{ tag: tags.regexp, class: 'tok-string2' },
				{ tag: tags.special(tags.string), class: 'tok-string2' },
				{ tag: tags.string, class: 'tok-string' },
				{ tag: tags.variableName, class: 'tok-variable' }
			]))
		]
	})
});

export class Editor {
	constructor() {
		this.container = null;
		this.defaultValue = '10*(t>>7|t|t>>6)+4*(t&t>>13|t>>6)';
		this.errorElem = null;
		this.view = null;
	}
	get value() {
		return this.view ? this.view.state.doc.toString() : this.defaultValue;
	}
	init() {
		document.getElementById('editor-default').remove();
		this.container = document.getElementById('editor-container');
		this.errorElem = document.getElementById('error');
		this.view = editorView(this.defaultValue);
	}
	setValue(code) {
		if(!this.view) {
			return;
		}
		this.view.dispatch({
			changes: {
				from: 0,
				to: this.view.state.doc.toString().length,
				insert: code
			}
		});
	}
	setExplorerHighlight(from, to) {
		if(!this.view) {
			return;
		}
		this.view.dispatch({ effects: setExplorerHighlight.of({ from, to }) });
	}
	clearExplorerHighlight() {
		if(!this.view) {
			return;
		}
		this.view.dispatch({ effects: setExplorerHighlight.of(null) });
	}
	// Push a set of currently-active source ranges to the editor — the
	// Strudel-style live highlight. `ranges` is an array of {from, to, color}.
	setActiveRanges(ranges) {
		if(!this.view) return;
		this.view.dispatch({ effects: setActiveRanges.of(ranges) });
	}
	clearActiveRanges() {
		if(!this.view) return;
		this.view.dispatch({ effects: setActiveRanges.of([]) });
	}
}
