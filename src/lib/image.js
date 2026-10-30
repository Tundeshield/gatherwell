// Shrinks an image file in the browser before upload so emails stay light and uploads stay small.
export async function prepareImage(file, { maxWidth = 1200, keepTransparency = false, maxBytes = 550_000 } = {}) {
  if (!/^image\/(png|jpeg|gif|webp)$/.test(file.type)) throw new Error('Please choose a PNG, JPG, GIF or WebP image.')
  if (file.type === 'image/gif' && file.size <= maxBytes) return readAsDataUrl(file) // keep animation
  const img = await loadImage(file)
  const scale = Math.min(1, maxWidth / img.naturalWidth)
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(img.naturalWidth * scale)
  canvas.height = Math.round(img.naturalHeight * scale)
  const g = canvas.getContext('2d')
  if (!keepTransparency) { g.fillStyle = '#FFFFFF'; g.fillRect(0, 0, canvas.width, canvas.height) }
  g.drawImage(img, 0, 0, canvas.width, canvas.height)
  if (keepTransparency) {
    const png = canvas.toDataURL('image/png')
    if (png.length * 0.75 <= maxBytes) return png
  }
  for (const q of [0.88, 0.8, 0.7, 0.6, 0.5]) {
    const jpg = canvas.toDataURL('image/jpeg', q)
    if (jpg.length * 0.75 <= maxBytes) return jpg
  }
  throw new Error('That image is too large. Please use a smaller one.')
}

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(r.result); r.onerror = () => reject(new Error('Could not read that file.')); r.readAsDataURL(file) })
}
function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => { URL.revokeObjectURL(url); resolve(img) }
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not open that image.')) }
    img.src = url
  })
}
