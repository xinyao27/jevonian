package routing

import (
	"sort"
	"time"

	"github.com/xinyao27/jevonian/internal/config"
)

// ScheduleStatus tells which schedule window applies at one instant. The dashboard
// shows it next to the per-window model lists.
type ScheduleStatus struct {
	Timezone string `json:"timezone"`
	// Now is the instant in the schedule's zone (RFC 3339).
	Now string `json:"now"`
	// Active is the id of the window that applies now. Empty means no window does,
	// so every routing uses its own models.
	Active      string `json:"active"`
	ActiveLabel string `json:"activeLabel,omitempty"`
	// NextChange is when the applicable window next changes (RFC 3339), and
	// NextActive is the window id that applies from then on (empty for none).
	NextChange string `json:"nextChange,omitempty"`
	NextActive string `json:"nextActive,omitempty"`
}

// scheduleLocation resolves the schedule zone. An empty or unknown name falls
// back to the machine's zone, so a bad config never stops routing.
func scheduleLocation(schedule *config.ScheduleConfig) *time.Location {
	if schedule != nil && schedule.Timezone != "" {
		if loc, err := time.LoadLocation(schedule.Timezone); err == nil {
			return loc
		}
	}
	return time.Local
}

func minuteOfDay(at time.Time) int { return at.Hour()*60 + at.Minute() }

// windowContains reports whether a minute of the day is inside the window.
func windowContains(window config.ScheduleWindow, minute int) bool {
	start, startOK := config.ParseClock(window.Start)
	end, endOK := config.ParseClock(window.End)
	if !startOK || !endOK || start == end {
		return false
	}
	if start < end {
		return minute >= start && minute < end
	}
	return minute >= start || minute < end // runs past midnight
}

// ActiveWindow returns the first window that contains at, or nil.
func ActiveWindow(schedule *config.ScheduleConfig, at time.Time) *config.ScheduleWindow {
	if schedule == nil {
		return nil
	}
	minute := minuteOfDay(at.In(scheduleLocation(schedule)))
	for i := range schedule.Windows {
		if windowContains(schedule.Windows[i], minute) {
			return &schedule.Windows[i]
		}
	}
	return nil
}

// sameWindow reports whether two ActiveWindow results are the same window (or both none).
func sameWindow(a, b *config.ScheduleWindow) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return a.ID == b.ID
}

// nextBoundary is the first start or end time after at where the applicable window
// changes. A boundary of a window that the first-match rule hides behind an earlier
// one (a lunch window inside a work window) changes nothing, so it is skipped.
// It returns false when the applicable window never changes.
func nextBoundary(schedule *config.ScheduleConfig, at time.Time) (time.Time, bool) {
	loc := scheduleLocation(schedule)
	local := at.In(loc)
	var candidates []time.Time
	for day := 0; day <= 2; day++ {
		for _, window := range schedule.Windows {
			for _, clock := range []string{window.Start, window.End} {
				minutes, ok := config.ParseClock(clock)
				if !ok {
					continue
				}
				candidate := time.Date(local.Year(), local.Month(), local.Day()+day, minutes/60, minutes%60, 0, 0, loc)
				if candidate.After(at) {
					candidates = append(candidates, candidate)
				}
			}
		}
	}
	sort.Slice(candidates, func(i, j int) bool { return candidates[i].Before(candidates[j]) })
	current := ActiveWindow(schedule, at)
	for _, candidate := range candidates {
		if !sameWindow(current, ActiveWindow(schedule, candidate)) {
			return candidate, true
		}
	}
	return time.Time{}, false
}

// Status reports the window that applies at at. It returns nil when no schedule is set.
func Status(schedule *config.ScheduleConfig, at time.Time) *ScheduleStatus {
	if schedule == nil {
		return nil
	}
	loc := scheduleLocation(schedule)
	status := &ScheduleStatus{Timezone: loc.String(), Now: at.In(loc).Format(time.RFC3339)}
	if schedule.Timezone != "" {
		status.Timezone = schedule.Timezone
	}
	if window := ActiveWindow(schedule, at); window != nil {
		status.Active, status.ActiveLabel = window.ID, window.Label
	}
	if next, ok := nextBoundary(schedule, at); ok {
		status.NextChange = next.Format(time.RFC3339)
		if window := ActiveWindow(schedule, next); window != nil {
			status.NextActive = window.ID
		}
	}
	return status
}

// ApplySchedule returns copies of entries with the active window's model lists in
// place of the routing's own. A routing with no list for the active window keeps
// its own models. The input is not changed.
func ApplySchedule(entries []config.RoutingEntry, schedule *config.ScheduleConfig, at time.Time) []config.RoutingEntry {
	out := make([]config.RoutingEntry, len(entries))
	copy(out, entries)
	window := ActiveWindow(schedule, at)
	if window == nil {
		return out
	}
	for i := range out {
		if models := out[i].Windows[window.ID]; len(models) > 0 {
			out[i].Models = append([]string{}, models...)
		}
	}
	return out
}

// clock is the current time for schedule decisions: Deps.Now when set, else the wall clock.
func (d Deps) clock() time.Time {
	if d.Now != nil {
		return time.UnixMilli(d.Now())
	}
	return time.Now()
}
