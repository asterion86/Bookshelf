// Add/edit book form: ISBN lookup and cover photos.
const form = document.getElementById('book-form');
const lookupButton = document.getElementById('lookup');
const lookupStatus = document.getElementById('lookup-status');
const fileInput = document.getElementById('cover-file');
const preview = document.getElementById('cover-preview');
const removeButton = document.getElementById('remove-cover');
const coverStatus = document.getElementById('cover-status');

const COVER_MAX_PX = 600;

// The cover the last lookup filled in, so a later lookup can clear it without
// touching a photo the member took or the cover a book already had.
let lookedUpCover = '';

function showCover(src) {
  preview.src = src;
  preview.hidden = !src;
  removeButton.hidden = !src;
}

function setLookedUpCover(src) {
  const ownPhoto = fileInput.files.length > 0;
  const replaceable = !form.cover_url.value || form.cover_url.value === lookedUpCover;
  if (ownPhoto || !replaceable) return;
  form.cover_url.value = src;
  lookedUpCover = src;
  showCover(src);
}

// Browsers restore typed values when going Back to a page; a fresh "Add a
// book" form should always start empty.
window.addEventListener('pageshow', (e) => {
  if (e.persisted && form.dataset.mode === 'new') {
    form.reset();
    lookedUpCover = '';
    lookupStatus.textContent = '';
    coverStatus.textContent = '';
    showCover('');
  }
});

// --- ISBN lookup -----------------------------------------------------------

async function lookup() {
  const isbn = form.isbn.value.replace(/[^0-9Xx]/g, '');
  if (isbn.length !== 10 && isbn.length !== 13) {
    lookupStatus.textContent = 'ISBNs are 10 or 13 digits.';
    return;
  }
  lookupStatus.textContent = 'Looking up… (Open Library can take a few seconds)';
  lookupButton.disabled = true;
  try {
    const res = await fetch(`/api/lookup?isbn=${isbn}`);
    const data = await res.json();
    // Replace everything from any earlier lookup, found or not.
    form.title.value = data.found ? data.title || '' : '';
    form.author.value = data.found ? data.author || '' : '';
    setLookedUpCover(data.found ? data.cover || '' : '');
    lookupStatus.textContent = data.found
      ? `Found it (from ${data.source}).`
      : 'Not found — fill it in by hand and add a photo of the cover.';
  } catch {
    lookupStatus.textContent = 'Lookup failed — fill it in by hand.';
  } finally {
    lookupButton.disabled = false;
  }
}

lookupButton.addEventListener('click', lookup);
form.isbn.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); lookup(); }
});

// --- Cover photos ----------------------------------------------------------

// Phone photos are several MB; shrink to a small JPEG before uploading.
async function shrink(file) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, COVER_MAX_PX / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('encode failed'))), 'image/jpeg', 0.82);
  });
}

fileInput.addEventListener('change', async () => {
  const file = fileInput.files[0];
  if (!file) return;
  coverStatus.textContent = 'Preparing photo…';
  try {
    const blob = await shrink(file);
    const resized = new DataTransfer();
    resized.items.add(new File([blob], 'cover.jpg', { type: 'image/jpeg' }));
    fileInput.files = resized.files;
    showCover(URL.createObjectURL(blob));
    coverStatus.textContent = '';
  } catch {
    fileInput.value = '';
    coverStatus.textContent = 'Couldn’t read that image — try a JPEG or PNG.';
  }
});

removeButton.addEventListener('click', () => {
  fileInput.value = '';
  form.cover_url.value = '';
  lookedUpCover = '';
  showCover('');
});
