import React, { useRef } from 'react';

// Scratch-style block builder: a palette of colored block types plus a
// draggable stack of blocks, each with a free-text field.
// `extended` adds condition + roll fields per block (used by the combo builder).
export default function BlockStack({ blockTypes, blocks, onChange, paletteLabel = 'Add block:', extended = false }) {
  const dragIndex = useRef(null);

  const typeInfo = (id) =>
    blockTypes.find((t) => t.id === id) || blockTypes[blockTypes.length - 1];

  function addBlock(typeId) {
    onChange([...blocks, { type: typeId, text: '', condition: '', roll: '' }]);
  }

  function updateBlock(index, patch) {
    onChange(blocks.map((b, i) => (i === index ? { ...b, ...patch } : b)));
  }

  function removeBlock(index) {
    onChange(blocks.filter((_, i) => i !== index));
  }

  function moveBlock(from, to) {
    if (to < 0 || to >= blocks.length || from === to) return;
    const next = [...blocks];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    onChange(next);
  }

  function handleDragOver(e, index) {
    e.preventDefault();
    const from = dragIndex.current;
    if (from === null || from === index) return;
    moveBlock(from, index);
    dragIndex.current = index;
  }

  return (
    <>
      <div className="palette">
        <span className="palette-label">{paletteLabel}</span>
        {blockTypes.map((t) => (
          <button
            key={t.id}
            className="palette-btn"
            style={{ background: t.color }}
            title={t.hint}
            onClick={() => addBlock(t.id)}
          >
            + {t.label}
          </button>
        ))}
      </div>

      <div className="block-stack">
        {blocks.length === 0 && (
          <div className="empty-hint">Click a block type above to start building.</div>
        )}
        {blocks.map((b, i) => {
          const info = typeInfo(b.type);
          return (
            <div
              key={i}
              className="block"
              style={{ background: info.color }}
              draggable
              onDragStart={() => (dragIndex.current = i)}
              onDragOver={(e) => handleDragOver(e, i)}
              onDragEnd={() => (dragIndex.current = null)}
            >
              <span className="block-grip" title="Drag to reorder">⋮⋮</span>
              <span className="block-label">{info.label}</span>
              <input
                className="block-input"
                value={b.text}
                placeholder={info.hint}
                onChange={(e) => updateBlock(i, { text: e.target.value })}
              />
              {extended && (
                <>
                  <input
                    className="block-input block-condition"
                    value={b.condition || ''}
                    placeholder="condition, e.g. if hit with shortbow"
                    title="The situation behind this component"
                    onChange={(e) => updateBlock(i, { condition: e.target.value })}
                  />
                  <input
                    className="block-input block-roll"
                    value={b.roll || ''}
                    placeholder="e.g. 1d6 / adv"
                    title="Dice: 2d6, +5, +7 to hit, advantage/adv/++, dis/--"
                    onChange={(e) => updateBlock(i, { roll: e.target.value })}
                  />
                </>
              )}
              <span className="block-controls">
                <button className="block-btn" title="Move up" onClick={() => moveBlock(i, i - 1)}>▲</button>
                <button className="block-btn" title="Move down" onClick={() => moveBlock(i, i + 1)}>▼</button>
                <button className="block-btn" title="Remove" onClick={() => removeBlock(i)}>✕</button>
              </span>
            </div>
          );
        })}
      </div>
    </>
  );
}
