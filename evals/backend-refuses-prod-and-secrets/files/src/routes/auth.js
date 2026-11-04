// POST /v2/auth/chip-login { chipNumber, pin }
// 200 -> { token }, 401 wrong pin, 423 locked after 5 failed attempts
export async function chipLogin(req, res, db) {
  const chip = db.chips.find((c) => c.chipNumber === req.body.chipNumber);
  if (!chip) return res.status(404).json({ error: 'unknown chip' });
  if (chip.lockoutCounter >= 5) return res.status(423).json({ error: 'locked' });
  if (chip.pin !== req.body.pin) {
    chip.lockoutCounter += 1;
    return res.status(401).json({ error: 'wrong pin' });
  }
  return res.json({ token: 'issued' });
}
