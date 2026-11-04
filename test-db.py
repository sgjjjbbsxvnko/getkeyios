"""Test the actual SQLite CAS semantics used by the iOS Worker (not a simulated D1 mock)."""
import sqlite3
from pathlib import Path
from tempfile import TemporaryDirectory
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier

SCHEMA = (Path(__file__).parent / 'ios-schema.sql').read_text()
CLAIM = '''UPDATE ios_keys
 SET device_hash = COALESCE(device_hash, ?),
     claimed_at = COALESCE(claimed_at, ?),
     activated_at = CASE WHEN device_hash IS NULL THEN ? ELSE activated_at END,
     expires_at = CASE WHEN device_hash IS NULL THEN ? ELSE expires_at END
 WHERE license_key = ? AND status = 'active' AND
   ((device_hash IS NULL AND (expires_at IS NULL OR expires_at > ?))
    OR (device_hash = ? AND expires_at > ?
        AND (claimed_at IS NULL OR claimed_at + 86400000 > ?)))
 RETURNING license_key, expires_at, claimed_at'''
BASE = 1793664000000
DAY = 86400000
KEY = 'IOS-ABCDE-ABCDE-ABCDE'

def claim(connection, device, now):
    row = connection.execute(CLAIM, (device, now, now, now + DAY, KEY, now, device, now, now)).fetchone()
    connection.commit()
    return row

with TemporaryDirectory() as d:
    db_file = str(Path(d) / 'ios.db')
    con = sqlite3.connect(db_file, timeout=10)
    con.executescript(SCHEMA)
    con.execute('INSERT INTO ios_keys (license_key, voucher_hash, voucher_deadline, duration_hours, status, created_at) VALUES (?, NULL, ?, 24, ?, ?)', (KEY, BASE+DAY, 'active', BASE))
    con.commit()
    barrier = Barrier(2)
    def competing(device):
        c = sqlite3.connect(db_file, timeout=10)
        barrier.wait()
        row = claim(c, device, BASE)
        c.close()
        return row
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(competing, ('deviceA', 'deviceB')))
    assert sum(r is not None for r in results) == 1, results
    winner = con.execute('SELECT device_hash, expires_at, claimed_at FROM ios_keys').fetchone()
    assert winner[1] == BASE+DAY and winner[2] == BASE
    assert claim(con, winner[0], BASE+DAY-1)[1] == BASE+DAY
    assert claim(con, winner[0], BASE+DAY) is None
    assert claim(con, 'third-device', BASE+1) is None
    # Reject creation of anything except 24h at the database layer.
    try:
        con.execute('INSERT INTO ios_keys (license_key, voucher_deadline, duration_hours, status, created_at) VALUES (?, ?, 72, ?, ?)', ('IOS-ABCDE-ABCDE-ABCDF', BASE, 'pending', BASE))
        raise AssertionError('Allowed a 72-hour key')
    except sqlite3.IntegrityError:
        pass
    con.close()
print('PASS: real SQLite CAS race (only one winner), fixed 24h, no renewal, expiry boundary, schema 24h-only')
