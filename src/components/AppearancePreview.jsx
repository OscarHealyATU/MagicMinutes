import React from 'react';
import { CONNECTION_TYPES } from '../views/PlacesView.jsx';
import { DISPOSITION_COLORS, RELATION_TYPES, dispositionOfNpc, dispositionTag } from '../lib/characters.mjs';
import { octagonPath, zoneFillStyle } from '../lib/mapZones.mjs';

// A live preview of what the Appearance settings actually change, shown right
// under the theme/font/colour-blind controls in Settings. It's built from the
// SAME constants, colours and CSS classes the real Map and Characters pages
// use — DISPOSITION_COLORS, CONNECTION_TYPES, RELATION_TYPES, zoneFillStyle,
// dispositionOfNpc, and classes like .map-zone-fill / .relation-edge — so it
// can never quietly drift from what the map or the tree actually look like.
// Theme and font style are CSS (data-theme/data-font on <html>) and colour
// palettes are var()s, so a plain, static SVG using the real classes already
// follows every one of those live; only the two things a view branches on in
// JS — colour-blind letter tags and dash patterns — are driven here by the
// `colorBlind` prop, same as the real views do.

const LINE_TYPES = CONNECTION_TYPES.filter((t) => t.dash !== undefined);
const LEVEL_RELATIONS = RELATION_TYPES.filter((t) => t.dir === 'level');

// Small fixed fixture — not real campaign data, just enough of a map and a
// tree to show every visual thing Appearance affects in one glance.
const OUTER_ZONE = { rect: { x: 14, y: 12, w: 330, h: 196 }, depth: 0, name: 'Cairne' };
const INNER_ZONE = { rect: { x: 210, y: 44, w: 122, h: 100 }, depth: 1, name: 'Anvils' };

const STATIONS = [
  { id: 'dock', name: 'Dockside', x: 60, y: 64 },
  { id: 'well', name: 'Old Well', x: 60, y: 150 },
  { id: 'ash', name: 'Ashgate', x: 240, y: 78 },
  { id: 'tanner', name: "Tanner's Row", x: 300, y: 128 },
  { id: 'high', name: 'Highbridge', x: 400, y: 40 }
];
const stationPos = (id) => {
  const s = STATIONS.find((st) => st.id === id);
  return { x: s.x, y: s.y };
};

// One line of each real connection type that's drawn on the map (the other
// two, inside/contains, become zones instead — no line to preview).
const LINES = [
  { from: 'dock', to: 'ash', type: 'between' },
  { from: 'well', to: 'dock', type: 'near' },
  { from: 'well', to: 'tanner', type: 'route' },
  { from: 'ash', to: 'high', type: 'direction' },
  { from: 'tanner', to: 'high', type: 'note' }
];

const NOTE_NPCS = [
  { name: 'Farah', alignment: 85 },
  { name: 'Grak', alignment: -85 }
];

const TREE_NPCS = [
  { id: 'alara', name: 'Alara', alignment: 85, x: 56, y: 58 },
  { id: 'grak', name: 'Grak', alignment: -85, x: 136, y: 58 },
  { id: 'tobin', name: 'Tobin', alignment: 0, x: 246, y: 58 }
];
const NODE_R = 14;

function connInfo(id) {
  return LINE_TYPES.find((t) => t.id === id) || LINE_TYPES[0];
}

export default function AppearancePreview({ colorBlind }) {
  return (
    <div className="appearance-preview">
      <div className="section-label">Preview</div>
      <p className="settings-help">Updates live as you change the options above.</p>

      <svg className="preview-map-svg" viewBox="0 0 460 220" role="img" aria-label="Preview of the map's zones, lines and stations">
        <g className="map-zone">
          <path className="map-zone-fill" d={octagonPath(OUTER_ZONE.rect)} style={zoneFillStyle(OUTER_ZONE.depth)} />
          <text className="map-zone-label" x={OUTER_ZONE.rect.x + 16} y={OUTER_ZONE.rect.y + 24}>
            {OUTER_ZONE.name}
          </text>
        </g>
        <g className="map-zone">
          <path className="map-zone-fill" d={octagonPath(INNER_ZONE.rect)} style={zoneFillStyle(INNER_ZONE.depth)} />
          <text className="map-zone-label" x={INNER_ZONE.rect.x + 14} y={INNER_ZONE.rect.y + 20}>
            {INNER_ZONE.name}
          </text>
        </g>

        {LINES.map((l, i) => {
          const a = stationPos(l.from);
          const b = stationPos(l.to);
          const info = connInfo(l.type);
          return (
            <line
              key={i}
              x1={a.x} y1={a.y} x2={b.x} y2={b.y}
              stroke={info.color}
              strokeDasharray={colorBlind ? info.dash : null}
              strokeWidth="5"
              strokeLinecap="round"
            />
          );
        })}

        {STATIONS.map((s) => (
          <g key={s.id} className="map-station" transform={`translate(${s.x},${s.y})`}>
            <circle r="6" strokeWidth="3" />
            <text className="map-station-label" x="10" y="4">{s.name}</text>
            {s.id === 'well' && (
              <g className="map-station-list" transform="translate(10,18)">
                <text className="map-list-note" x="0" y="0">📜 Rumor of a ghost</text>
                {NOTE_NPCS.map((npc, i) => {
                  const disp = dispositionOfNpc(npc);
                  return (
                    <g key={npc.name} transform={`translate(0,${14 * (i + 1)})`}>
                      <circle className="map-list-npc-dot" cx="3" cy="-4" r="3" style={{ fill: DISPOSITION_COLORS[disp] }} />
                      <text className="map-list-npc" x="10" y="0">
                        {colorBlind ? `[${dispositionTag(disp)}] ` : ''}
                        {npc.name}
                      </text>
                    </g>
                  );
                })}
              </g>
            )}
          </g>
        ))}
      </svg>

      <div className="preview-map-legend">
        {LINE_TYPES.map((t) => (
          <div key={t.id} className="map-legend-row">
            <svg className="map-legend-swatch" width="22" height="10" aria-hidden="true">
              <line x1="1" y1="5" x2="21" y2="5" stroke={t.color} strokeWidth="4" strokeDasharray={colorBlind ? t.dash : null} strokeLinecap="round" />
            </svg>
            {t.label}
          </div>
        ))}
        <div className="map-legend-row">
          <span className="map-legend-swatch map-legend-zone" style={{ background: zoneFillStyle(0).fill }} />
          Zone
        </div>
      </div>

      <svg className="preview-tree-svg" viewBox="0 0 460 100" role="img" aria-label="Preview of the characters tree's nodes, group box and relationship lines">
        <g className="group-hull">
          <rect x="20" y="18" width="160" height="80" rx="20" style={{ stroke: '#0f3a5c' }} />
          <text className="group-hull-label" x="34" y="34" style={{ fill: 'color-mix(in srgb, #0f3a5c 45%, var(--text))' }}>
            The Ashgate Crew · 2
          </text>
        </g>
        <line className="relation-edge level" x1={TREE_NPCS[0].x} y1={TREE_NPCS[0].y} x2={TREE_NPCS[1].x} y2={TREE_NPCS[1].y}
          style={{ stroke: LEVEL_RELATIONS.find((r) => r.id === 'rival').color, strokeDasharray: colorBlind ? LEVEL_RELATIONS.find((r) => r.id === 'rival').dash || 'none' : undefined }} />
        <line className="relation-edge level" x1={TREE_NPCS[1].x} y1={TREE_NPCS[1].y} x2={TREE_NPCS[2].x} y2={TREE_NPCS[2].y}
          style={{ stroke: LEVEL_RELATIONS.find((r) => r.id === 'knows').color, strokeDasharray: colorBlind ? LEVEL_RELATIONS.find((r) => r.id === 'knows').dash || 'none' : undefined }} />
        {TREE_NPCS.map((npc) => {
          const disp = dispositionOfNpc(npc);
          return (
            <g key={npc.id} className="char-node" transform={`translate(${npc.x},${npc.y})`}>
              <circle r={NODE_R} fill={DISPOSITION_COLORS[disp]} />
              {colorBlind && <text className="char-node-tag" y="4">{dispositionTag(disp)}</text>}
              <text className="char-node-label" y={NODE_R + 14}>{npc.name}</text>
            </g>
          );
        })}
        <g className="preview-relation-legend" transform="translate(280,10)">
          {LEVEL_RELATIONS.map((r, i) => (
            <g key={r.id} transform={`translate(0,${i * 17})`}>
              <line className="relation-edge level" x1="0" y1="6" x2="26" y2="6" style={{ stroke: r.color, strokeDasharray: colorBlind ? r.dash || 'none' : undefined }} />
              <text className="preview-relation-legend-label" x="34" y="10">{r.label}</text>
            </g>
          ))}
        </g>
      </svg>

      <h3 className="preview-demo-heading">The Sunken Bell Tower</h3>
      <p className="preview-demo-body">
        Half-sunk in Greywater Marsh, it rings on its own before a storm — nobody's found who (or
        what) rings it.
      </p>
      <p className="settings-help">Session 14 · last updated 2 days ago</p>
    </div>
  );
}
