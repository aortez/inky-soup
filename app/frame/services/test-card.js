// All marks are black and white so the card works on both supported palettes.
export async function orientationTestCard(config) {
  const canvas = document.createElement('canvas');
  const {width, height} = config;
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext('2d');
  const unit = Math.min(width, height) / 100;
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = '#000'; ctx.lineWidth = Math.max(2, unit);
  ctx.strokeRect(unit * 2, unit * 2, width - unit * 4, height - unit * 4);
  ctx.fillStyle = '#000'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  const label = (text, x, y, size = 6) => {
    ctx.font = `bold ${Math.round(unit * size)}px sans-serif`;
    ctx.fillText(text, x, y);
  };
  label('TOP', width / 2, unit * 10);
  label('BOTTOM', width / 2, height - unit * 10);
  ctx.save(); ctx.translate(unit * 10, height / 2); ctx.rotate(-Math.PI / 2); label('LEFT', 0, 0); ctx.restore();
  ctx.save(); ctx.translate(width - unit * 10, height / 2); ctx.rotate(Math.PI / 2); label('RIGHT', 0, 0); ctx.restore();
  ctx.beginPath(); ctx.moveTo(width / 2, height * 0.25); ctx.lineTo(width / 2 - unit * 6, height * 0.25 + unit * 8);
  ctx.lineTo(width / 2 - unit * 2, height * 0.25 + unit * 8); ctx.lineTo(width / 2 - unit * 2, height * 0.43);
  ctx.lineTo(width / 2 + unit * 2, height * 0.43); ctx.lineTo(width / 2 + unit * 2, height * 0.25 + unit * 8);
  ctx.lineTo(width / 2 + unit * 6, height * 0.25 + unit * 8); ctx.closePath(); ctx.fill();
  label('THIS WAY UP', width / 2, height * 0.51, 5);
  label(`${config.rotation_degrees}° CLOCKWISE`, width / 2, height * 0.61, 4);
  label(`${width} × ${height}`, width / 2, height * 0.69, 4);
  // Remove text antialiasing: the display accepts only exact palette colors.
  const pixels = ctx.getImageData(0, 0, width, height);
  for (let i = 0; i < pixels.data.length; i += 4) {
    const color = pixels.data[i] < 128 ? 0 : 255;
    pixels.data[i] = color; pixels.data[i + 1] = color; pixels.data[i + 2] = color;
  }
  ctx.putImageData(pixels, 0, 0);
  return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Could not draw the test card.')), 'image/png'));
}
