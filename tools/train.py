# Trains a small CNN on Arabic handwriting (AHCD) and exports int8 weights as JSON for the browser.
# The same normalization (crop -> fit 22px in 32 -> threshold -> thin -> dilate) is reimplemented in js/cnn.js.
import base64, json, os, sys, time
from pathlib import Path
import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F
from PIL import Image

torch.set_num_threads(int(os.environ.get("THREADS", os.cpu_count() or 4)))
torch.manual_seed(0)
np.random.seed(0)

ARR = Path(sys.argv[1])
OUT = Path(sys.argv[2])
EPOCHS = int(sys.argv[3]) if len(sys.argv) > 3 else 30
S, FIT = 32, 22


def thin(m):
    """Zhang-Suen thinning on a batch (N,H,W) of 0/1 uint8."""
    m = m.copy()
    while True:
        changed = False
        for step in (0, 1):
            P = np.pad(m, ((0, 0), (1, 1), (1, 1)))
            p2, p3, p4 = P[:, :-2, 1:-1], P[:, :-2, 2:], P[:, 1:-1, 2:]
            p5, p6, p7 = P[:, 2:, 2:], P[:, 2:, 1:-1], P[:, 2:, :-2]
            p8, p9 = P[:, 1:-1, :-2], P[:, :-2, :-2]
            nb = [p2, p3, p4, p5, p6, p7, p8, p9]
            B = sum(n.astype(np.int16) for n in nb)
            A = sum(((nb[i] == 0) & (nb[(i + 1) % 8] == 1)).astype(np.int16) for i in range(8))
            if step == 0:
                c = (p2 * p4 * p6 == 0) & (p4 * p6 * p8 == 0)
            else:
                c = (p2 * p4 * p8 == 0) & (p2 * p6 * p8 == 0)
            d = (m == 1) & (B >= 2) & (B <= 6) & (A == 1) & c
            if d.any():
                m[d] = 0
                changed = True
        if not changed:
            return m


def dilate(m):
    o = m.copy()
    o[:, 1:, :] |= m[:, :-1, :]
    o[:, :-1, :] |= m[:, 1:, :]
    o[:, :, 1:] |= m[:, :, :-1]
    o[:, :, :-1] |= m[:, :, 1:]
    return o


def normalize(x):
    """x: (N,h,w) float 0..1 white ink -> (N,32,32) float 0/1."""
    out = np.zeros((len(x), S, S), dtype=np.uint8)
    for i, img in enumerate(x):
        ys, xs = np.where(img > 0.35)
        if len(ys) == 0:
            continue
        crop = img[ys.min():ys.max() + 1, xs.min():xs.max() + 1]
        h, w = crop.shape
        s = FIT / max(h, w)
        nh, nw = max(1, round(h * s)), max(1, round(w * s))
        r = np.asarray(Image.fromarray((crop * 255).astype(np.uint8)).resize((nw, nh), Image.BILINEAR), dtype=np.float32) / 255
        oy, ox = (S - nh) // 2, (S - nw) // 2
        out[i, oy:oy + nh, ox:ox + nw] = (r > 0.3).astype(np.uint8)
    return dilate(thin(out)).astype(np.float32)


def load(split):
    d = np.load(ARR / f'ahcd_{split}.npz')
    return normalize(d['x']), d['y']


class Net(nn.Module):
    def __init__(self, n):
        super().__init__()
        self.c1 = nn.Conv2d(1, 32, 3, padding=1)
        self.c2 = nn.Conv2d(32, 32, 3, padding=1)
        self.c3 = nn.Conv2d(32, 64, 3, padding=1)
        self.c4 = nn.Conv2d(64, 64, 3, padding=1)
        self.c5 = nn.Conv2d(64, 128, 3, padding=1)
        self.f1 = nn.Linear(128 * 4 * 4, 128)
        self.f2 = nn.Linear(128, n)
        self.drop = nn.Dropout(0.4)

    def forward(self, x):
        x = F.max_pool2d(F.relu(self.c2(F.relu(self.c1(x)))), 2)
        x = F.max_pool2d(F.relu(self.c4(F.relu(self.c3(x)))), 2)
        x = F.max_pool2d(F.relu(self.c5(x)), 2)
        x = self.drop(F.relu(self.f1(x.flatten(1))))
        return self.f2(x)


def augment(x):
    """Random affine + small elastic wobble, like a shaky hand in the air."""
    n = x.shape[0]
    ang = (torch.rand(n) - 0.5) * 2 * np.radians(14)
    sc = 1 + (torch.rand(n) - 0.5) * 0.3
    sh = (torch.rand(n) - 0.5) * 0.5
    asp = 1 + (torch.rand(n) - 0.5) * 0.35
    tx, ty = (torch.rand(n) - 0.5) * 0.16, (torch.rand(n) - 0.5) * 0.16
    cos, sin = torch.cos(ang), torch.sin(ang)
    theta = torch.zeros(n, 2, 3)
    theta[:, 0, 0] = cos / sc * asp
    theta[:, 0, 1] = (-sin + sh) / sc
    theta[:, 1, 0] = sin / sc
    theta[:, 1, 1] = cos / sc / asp
    theta[:, 0, 2], theta[:, 1, 2] = tx, ty
    grid = F.affine_grid(theta, x.shape, align_corners=False)
    noise = F.interpolate(torch.randn(n, 2, 4, 4) * 0.035, size=(S, S), mode='bicubic', align_corners=False)
    grid = grid + noise.permute(0, 2, 3, 1)
    y = F.grid_sample(x, grid, align_corners=False, padding_mode='zeros')
    return (y > 0.45).float()


def accuracy(model, x, y, aug=False):
    model.eval()
    ok = 0
    with torch.no_grad():
        for i in range(0, len(x), 1024):
            xb = x[i:i + 1024]
            if aug:
                xb = augment(xb)
            ok += (model(xb).argmax(1) == y[i:i + 1024]).sum().item()
    return ok / len(x)


def export(model, path, labels, meta):
    layers = {}
    for name, p in model.state_dict().items():
        a = p.detach().numpy().astype(np.float32)
        scale = float(np.abs(a).max() / 127) or 1.0
        q = np.clip(np.round(a / scale), -127, 127).astype(np.int8)
        layers[name] = {'shape': list(a.shape), 'scale': scale, 'data': base64.b64encode(q.tobytes()).decode()}
    path.write_text(json.dumps({'labels': labels, 'size': S, 'fit': FIT, 'meta': meta, 'layers': layers}))


if __name__ == '__main__':
    t0 = time.time()
    xtr, ytr = load('train')
    xte, yte = load('test')
    print(f'train {xtr.shape} test {xte.shape} prep {time.time() - t0:.0f}s', flush=True)
    np.savez_compressed(OUT / 'norm_test.npz', x=xte[:400], y=yte[:400])
    xtr, ytr = torch.from_numpy(xtr)[:, None], torch.from_numpy(ytr)
    xte, yte = torch.from_numpy(xte)[:, None], torch.from_numpy(yte)
    n = int(ytr.max()) + 1
    model = Net(n)
    opt = torch.optim.AdamW(model.parameters(), lr=2e-3, weight_decay=1e-4)
    steps = EPOCHS * ((len(xtr) + 127) // 128)
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=3e-3, total_steps=steps)
    best = 0
    for ep in range(EPOCHS):
        model.train()
        perm = torch.randperm(len(xtr))
        for i in range(0, len(xtr), 128):
            idx = perm[i:i + 128]
            xb = augment(xtr[idx])
            loss = F.cross_entropy(model(xb), ytr[idx], label_smoothing=0.05)
            opt.zero_grad()
            loss.backward()
            opt.step()
            sched.step()
        clean, noisy = accuracy(model, xte, yte), accuracy(model, xte, yte, aug=True)
        print(f'epoch {ep + 1}/{EPOCHS} loss {loss.item():.3f} test {clean:.4f} test+aug {noisy:.4f} {time.time() - t0:.0f}s', flush=True)
        if clean > best:
            best = clean
            labels = [*'ابتثجحخدذرزسشصضطظعغفقكلمنهوي']
            export(model, OUT / 'model_ar.json', labels, {'test_accuracy': round(clean, 4), 'test_aug_accuracy': round(noisy, 4), 'epoch': ep + 1})
    print('best', best)
