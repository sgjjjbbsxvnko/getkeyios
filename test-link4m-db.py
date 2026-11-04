"""Check the production-like Link4M two-step SQL and D1 batch semantics in real SQLite."""
import sqlite3
from pathlib import Path
from tempfile import TemporaryDirectory
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier

root = Path(__file__).parent
schema = (root / 'ios-schema.sql').read_text()
base = 1793750400000
expire = base + 20*60*1000
session = 'b'*64

claim_sql = '''UPDATE ios_link_sessions SET stage = 'complete', license_key = ?, completed_at = ?
      WHERE session_hash = ? AND stage = 'ready' AND expires_at > ?
      RETURNING license_key'''
insert_sql = '''INSERT INTO ios_keys (license_key, voucher_hash, voucher_deadline, duration_hours, status, created_at)
      SELECT ?, NULL, 0, 24, 'active', ? FROM ios_link_sessions
      WHERE session_hash = ? AND stage = 'complete' AND license_key = ?'''
with TemporaryDirectory() as directory:
    db = str(Path(directory) / 'demo.sqlite')
    c = sqlite3.connect(db, timeout=20)
    c.executescript(schema)
    c.execute('INSERT INTO ios_link_sessions(session_hash,created_at,expires_at,stage) VALUES (?,?,?,?)',
              (session, base, expire, 'started'))
    # completing before the callbacks cannot create a license
    with c:
        assert c.execute(claim_sql, ('IOS-ABCDE-ABCDE-ABCDE', base, session, base)).fetchone() is None
        c.execute(insert_sql, ('IOS-ABCDE-ABCDE-ABCDE', base, session, 'IOS-ABCDE-ABCDE-ABCDE'))
    assert c.execute('SELECT COUNT(*) FROM ios_keys').fetchone()[0] == 0
    # callbacks transition in order only
    with c:
        c.execute("UPDATE ios_link_sessions SET stage='step1_seen',stage2_hash='hash1' WHERE session_hash=? AND stage='started' AND expires_at>?", (session, base))
        c.execute("UPDATE ios_link_sessions SET stage='ready',stage2_hash=NULL WHERE session_hash=? AND stage='step1_seen' AND stage2_hash=? AND expires_at>?", (session, 'hash1', base))
    barrier=Barrier(2)
    def issue(key):
        d=sqlite3.connect(db,timeout=20)
        barrier.wait()
        with d:
            result=d.execute(claim_sql,(key,base,session,base)).fetchone()
            d.execute(insert_sql,(key,base,session,key))
        d.close()
        return result
    with ThreadPoolExecutor(max_workers=2) as pool:
        out = list(pool.map(issue,['IOS-ABCDE-ABCDE-ABCDE','IOS-ABCDE-ABCDE-ABCDF']))
    assert sum(r is not None for r in out) == 1, out
    assert c.execute('SELECT COUNT(*) FROM ios_keys').fetchone()[0] == 1
    assert c.execute("SELECT duration_hours, status, claimed_at, expires_at FROM ios_keys").fetchone() == (24,'active',None,None)
    assert c.execute("SELECT stage FROM ios_link_sessions WHERE session_hash=?",(session,)).fetchone()[0] == 'complete'
    c.close()
print('PASS: real SQLite Link4M session stages, atomic dual completion, one 24h unactivated license')
