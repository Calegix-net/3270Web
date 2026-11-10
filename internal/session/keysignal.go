// SPDX-License-Identifier: AGPL-3.0-or-later

package session

import "time"

// keySignal is what a session knows about the operator's last key: when it
// went to the host, and a channel closed at that moment so anything waiting
// to show the host's answer can wake straight away rather than on its next
// timer.
//
// It has a lock of its own rather than sharing the session's, because the
// key path marks it while other work on the session is under way, and the
// live screen stream reads it on every pass.
type keySignal struct {
	sentAt time.Time
	ch     chan struct{}
}

// NoteKeySent records that a key has just gone to the host and wakes every
// waiter on the previous signal.
func (s *Session) NoteKeySent() {
	if s == nil {
		return
	}
	s.keyMu.Lock()
	defer s.keyMu.Unlock()
	s.key.sentAt = time.Now()
	if s.key.ch != nil {
		close(s.key.ch)
	}
	s.key.ch = make(chan struct{})
}

// KeySignal returns when the last key was sent (zero if none has been) and a
// channel that is closed when the next one is.
func (s *Session) KeySignal() (time.Time, <-chan struct{}) {
	if s == nil {
		return time.Time{}, nil
	}
	s.keyMu.Lock()
	defer s.keyMu.Unlock()
	if s.key.ch == nil {
		s.key.ch = make(chan struct{})
	}
	return s.key.sentAt, s.key.ch
}

// NextScreenSeq numbers a screen read from the host for the browser. The
// numbers only go up, so of two screens that reach the browser by different
// paths it can tell which the host drew last.
func (s *Session) NextScreenSeq() uint64 {
	if s == nil {
		return 0
	}
	return s.screenSeq.Add(1)
}
