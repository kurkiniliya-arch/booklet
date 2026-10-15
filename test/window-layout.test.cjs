'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {layoutFor, centerForLayouts, boundsAtCenter, BOOK_WIDTH, BOOK_HEIGHT, COVER_WIDTH, COVER_HEIGHT, BOOK_DIAGONAL} = require('../src/window-layout.cjs');

const work = (width, height, x = 0, y = 0) => ({x, y, width, height});
function fits(bounds, area) {
  assert.ok(bounds.width <= area.width && bounds.height <= area.height, 'native extent fits work area');
  assert.ok(bounds.x >= area.x && bounds.y >= area.y, 'top/left fit work area');
  assert.ok(bounds.x + bounds.width <= area.x + area.width && bounds.y + bounds.height <= area.y + area.height, 'bottom/right fit work area');
}
function nearly(actual, expected, tolerance = 1e-8) { assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} ≈ ${expected}`); }

test('open, turned and cover layouts keep one scale and preserve their original dimensions', () => {
  const area = work(1920, 1080);
  const landscape = layoutFor(area);
  assert.equal(landscape.stageWidth, BOOK_WIDTH);
  assert.equal(landscape.stageHeight, BOOK_HEIGHT);
  assert.equal(landscape.width, 1140);
  assert.equal(landscape.height, 750);
  assert.equal(landscape.scale, 1);
  const portrait = layoutFor(area, {rotated: true});
  nearly(portrait.scale, 1080 / 1140);
  assert.equal(portrait.height, 1080);
  assert.ok(portrait.width >= 750 * portrait.scale && portrait.width < 750 * portrait.scale + 1);
  assert.equal(portrait.stageWidth, BOOK_WIDTH);
  assert.equal(portrait.stageHeight, BOOK_HEIGHT);
  const cover = layoutFor(area, {open: false, rotated: true});
  assert.equal(cover.width, COVER_WIDTH);
  assert.equal(cover.height, COVER_HEIGHT);
  assert.equal(cover.scale, 1);
  assert.equal(cover.open, false);
  assert.equal(cover.turning, false);
});

test('all final layouts use uniform fitting on small, wide, tall and offset screens', () => {
  for (const area of [work(1920, 1040),work(1280, 720),work(1024, 600),work(800, 550),work(400, 300),work(1, 1),work(1080, 1880, -1080, -120),work(2560, 1400, 1920, 0)]) {
    for (const settings of [{open: true, rotated: false},{open: true, rotated: true},{open: false, rotated: false}]) {
      const layout = layoutFor(area,settings);
      const targetWidth = settings.open && settings.rotated ? BOOK_HEIGHT : layout.stageWidth;
      const targetHeight = settings.open && settings.rotated ? BOOK_WIDTH : layout.stageHeight;
      nearly(layout.scale,Math.min(1,area.width / targetWidth,area.height / targetHeight));
      assert.ok(layout.width >= targetWidth * layout.scale - 1e-8);
      assert.ok(layout.height >= targetHeight * layout.scale - 1e-8);
      assert.ok(layout.width - targetWidth * layout.scale < 1 + 1e-8);
      assert.ok(layout.height - targetHeight * layout.scale < 1 + 1e-8);
      const center = centerForLayouts({x:area.x - 100,y:area.y - 100,width:200,height:200},area,[layout]);
      fits(boundsAtCenter(layout,center,area),area);
    }
  }
});

test('the square animation layout contains the whole book at every intermediate angle', () => {
  for (const area of [work(1920,1040),work(1280,720),work(800,550),work(400,300),work(2560,1600)]) {
    const layout = layoutFor(area,{rotated:true,turning:true});
    assert.equal(layout.width,layout.height);
    assert.equal(layout.turning,true);
    nearly(layout.scale,Math.min(1,(area.width - 24) / BOOK_DIAGONAL,(area.height - 24) / BOOK_DIAGONAL));
    assert.equal(layout.scale,layout.turnScale);
    for (let degrees = 0; degrees <= 90; degrees++) {
      const angle = degrees * Math.PI / 180;
      const rotatedWidth = (BOOK_WIDTH * Math.cos(angle) + BOOK_HEIGHT * Math.sin(angle)) * layout.scale;
      const rotatedHeight = (BOOK_WIDTH * Math.sin(angle) + BOOK_HEIGHT * Math.cos(angle)) * layout.scale;
      assert.ok(rotatedWidth <= layout.width + 1e-8, `${degrees}° width remains inside`);
      assert.ok(rotatedHeight <= layout.height + 1e-8, `${degrees}° height remains inside`);
    }
    assert.ok(layout.width <= area.width - 24);
    assert.ok(layout.height <= area.height - 24);
  }
});

test('prepared and final windows share a center that fits both near monitor edges', () => {
  const area = work(1920,1040,-1920,80);
  for (const rotated of [false,true]) {
    const prepared = layoutFor(area,{rotated,turning:true});
    const final = layoutFor(area,{rotated});
    for (const old of [
      {x:area.x,y:area.y,width:1140,height:750},
      {x:area.x + 1400,y:area.y + 500,width:500,height:500},
      {x:area.x - 200,y:area.y - 200,width:1140,height:750}
    ]) {
      const center = centerForLayouts(old,area,[prepared,final]);
      const first = boundsAtCenter(prepared,center,area);
      const last = boundsAtCenter(final,center,area);
      fits(first,area);
      fits(last,area);
      nearly(first.x + first.width / 2,last.x + last.width / 2,0.5);
      nearly(first.y + first.height / 2,last.y + last.height / 2,0.5);
    }
  }
});

test('finishing the rotation never shrinks a native axis below the currently displayed rotated book', () => {
  for (const area of [work(1920,1040),work(1280,720),work(800,550),work(1080,1880)]) {
    for (const rotated of [false,true]) {
      const transition = layoutFor(area,{rotated,turning:true});
      const final = layoutFor(area,{rotated});
      const width = rotated ? BOOK_HEIGHT : BOOK_WIDTH;
      const height = rotated ? BOOK_WIDTH : BOOK_HEIGHT;
      assert.ok(final.width >= width * transition.scale);
      assert.ok(final.height >= height * transition.scale);
      assert.ok(final.scale >= transition.scale);
    }
  }
});

test('cover and initial book can shrink below former independent minimum sizes without clipping', () => {
  const area = work(300,220);
  const cover = layoutFor(area,{open:false});
  nearly(cover.scale,220 / COVER_HEIGHT);
  assert.equal(cover.height,220);
  assert.ok(cover.width < 320);
  const book = layoutFor(area);
  nearly(book.scale,300 / BOOK_WIDTH);
  assert.equal(book.width,300);
  assert.ok(book.height < 220);
});

test('invalid work area and orientation types are rejected', () => {
  for (const area of [null,{},work(0,750),work(1140,-1),work(Infinity,750),work(1140,NaN)]) assert.throws(() => layoutFor(area),TypeError);
  for (const settings of [{rotated:'true'},{open:0},{turning:null}]) assert.throws(() => layoutFor(work(1920,1040),settings),TypeError);
});
