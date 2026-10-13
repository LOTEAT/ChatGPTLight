const TILE_WIDTH = 128;
const GAP = 8;
const PADDING = 24;
const HEIGHT = 164;

function getWidgetSize(count, scale, workArea) {
  scale = Math.max(0.4, Math.min(2, Number(scale) || 1));
  const maxColumns = Math.max(1, Math.min(6, Math.floor(((workArea.width - 24) / scale - PADDING + GAP) / (TILE_WIDTH + GAP))));
  const columns = Math.min(maxColumns, Math.max(2, Math.min(Number(count) || 0, 6)));
  return { columns, scale, width: Math.round((PADDING + columns * TILE_WIDTH + (columns - 1) * GAP) * scale), height: Math.round(HEIGHT * scale) };
}

function getWidgetBounds(size, workArea, previous) {
  const right = previous ? previous.x + previous.width : workArea.x + workArea.width - 24;
  const x = Math.round(Math.max(workArea.x, Math.min(right - size.width, workArea.x + workArea.width - size.width)));
  const y = Math.round(Math.max(workArea.y, Math.min(previous?.y ?? workArea.y + workArea.height - size.height - 24, workArea.y + workArea.height - size.height)));
  return { x, y, width: size.width, height: size.height };
}

module.exports = { getWidgetSize, getWidgetBounds };
