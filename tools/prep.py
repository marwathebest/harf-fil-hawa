# Loads AHCD + EMNIST letters into numpy arrays (white ink on black, 0..1) and writes contact sheets to check labels.
import io, re, sys, zipfile
from pathlib import Path
import numpy as np
from PIL import Image
import pyarrow.parquet as pq

DATA = Path(sys.argv[1])
OUT = Path(sys.argv[2])
OUT.mkdir(parents=True, exist_ok=True)


def load_ahcd(name):
    xs, ys = [], []
    with zipfile.ZipFile(DATA / 'ahcd' / f'{name}.zip') as z:
        for n in z.namelist():
            m = re.search(r'label_(\d+)\.png$', n)
            if not m:
                continue
            img = np.array(Image.open(io.BytesIO(z.read(n))).convert('L'), dtype=np.float32) / 255.0
            xs.append(img)
            ys.append(int(m.group(1)) - 1)
    return np.stack(xs), np.array(ys, dtype=np.int64)


def load_emnist(name):
    t = pq.read_table(DATA / 'emnist' / f'{name}.parquet').to_pydict()
    xs = [np.array(Image.open(io.BytesIO(im['bytes'])).convert('L'), dtype=np.float32) / 255.0 for im in t['image']]
    return np.stack(xs), np.array(t['label'], dtype=np.int64)


def sheet(x, y, classes, path, per=8):
    h, w = x.shape[1:]
    canvas = np.zeros((classes * h, per * w), dtype=np.float32)
    for c in range(classes):
        idx = np.where(y == c)[0][:per]
        for j, i in enumerate(idx):
            canvas[c * h:(c + 1) * h, j * w:(j + 1) * w] = x[i]
    Image.fromarray((canvas * 255).astype(np.uint8)).resize((per * w * 2, classes * h * 2), Image.NEAREST).save(path)


for name in ('train', 'test'):
    x, y = load_ahcd(name)
    print('ahcd', name, x.shape, np.bincount(y).min(), np.bincount(y).max(), 'mean', x.mean().round(3))
    np.savez_compressed(OUT / f'ahcd_{name}.npz', x=x, y=y)
    if name == 'train':
        sheet(x, y, 28, OUT / 'ahcd_sheet.png')
    x, y = load_emnist(name)
    print('emnist', name, x.shape, y.min(), y.max(), 'mean', x.mean().round(3))
    np.savez_compressed(OUT / f'emnist_{name}.npz', x=x, y=y)
    if name == 'train':
        sheet(x, y, 26, OUT / 'emnist_sheet.png')
