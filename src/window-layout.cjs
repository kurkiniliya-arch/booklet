'use strict';

const BOOK_WIDTH = 1140;
const BOOK_HEIGHT = 750;
const COVER_WIDTH = 410;
const COVER_HEIGHT = 580;
const TURN_DURATION = 420;
const TURN_MARGIN = 24;
const BOOK_DIAGONAL = Math.hypot(BOOK_WIDTH, BOOK_HEIGHT);

function validWorkArea(workArea) {
  if (!workArea || !['x','y','width','height'].every(key => Number.isFinite(workArea[key])) || workArea.width < 1 || workArea.height < 1) {
    throw new TypeError('Некорректная рабочая область экрана.');
  }
  return workArea;
}

function roundedExtent(value) {
  // Avoid adding a pixel to an integral fit because of floating-point noise.
  return Math.max(1, Math.ceil(value - 1e-9));
}

function layoutFor(workArea, {open = true, rotated = false, turning = false} = {}) {
  validWorkArea(workArea);
  if ([open, rotated, turning].some(value => typeof value !== 'boolean')) throw new TypeError('Некорректное положение книги.');
  const turnScale = Math.min(1, Math.max(1, workArea.width - TURN_MARGIN) / BOOK_DIAGONAL, Math.max(1, workArea.height - TURN_MARGIN) / BOOK_DIAGONAL);
  const stageWidth = open ? BOOK_WIDTH : COVER_WIDTH;
  const stageHeight = open ? BOOK_HEIGHT : COVER_HEIGHT;
  const isTurning = open && turning;
  const targetWidth = isTurning ? BOOK_DIAGONAL : open && rotated ? BOOK_HEIGHT : stageWidth;
  const targetHeight = isTurning ? BOOK_DIAGONAL : open && rotated ? BOOK_WIDTH : stageHeight;
  const scale = isTurning ? turnScale : Math.min(1, workArea.width / targetWidth, workArea.height / targetHeight);
  return {
    width: roundedExtent(targetWidth * scale),
    height: roundedExtent(targetHeight * scale),
    scale,
    stageWidth,
    stageHeight,
    rotated,
    open,
    turning: isTurning,
    turnScale,
    duration: TURN_DURATION
  };
}

function clamp(value, lower, upper) { return Math.max(lower, Math.min(value, upper)); }

function centerForLayouts(bounds, workArea, layouts) {
  validWorkArea(workArea);
  if (!bounds || !['x','y','width','height'].every(key => Number.isFinite(bounds[key])) || !Array.isArray(layouts) || !layouts.length) {
    throw new TypeError('Некорректные размеры окна.');
  }
  const maxWidth = Math.max(...layouts.map(layout => layout.width));
  const maxHeight = Math.max(...layouts.map(layout => layout.height));
  return {
    x: clamp(bounds.x + bounds.width / 2, workArea.x + maxWidth / 2, workArea.x + workArea.width - maxWidth / 2),
    y: clamp(bounds.y + bounds.height / 2, workArea.y + maxHeight / 2, workArea.y + workArea.height - maxHeight / 2)
  };
}

function boundsAtCenter(layout, center, workArea) {
  validWorkArea(workArea);
  return {
    x: clamp(Math.round(center.x - layout.width / 2), Math.ceil(workArea.x), Math.floor(workArea.x + workArea.width - layout.width)),
    y: clamp(Math.round(center.y - layout.height / 2), Math.ceil(workArea.y), Math.floor(workArea.y + workArea.height - layout.height)),
    width: layout.width,
    height: layout.height
  };
}

module.exports = {layoutFor, centerForLayouts, boundsAtCenter, BOOK_WIDTH, BOOK_HEIGHT, COVER_WIDTH, COVER_HEIGHT, BOOK_DIAGONAL, TURN_DURATION};
