package cli

import (
	"fmt"
	"time"

	"github.com/xinyao27/jevonian/internal/config"
	"github.com/xinyao27/jevonian/internal/routing"
)

// scheduleLines describes the time schedule for `doctor` and the serve banner.
// It returns nil when no schedule is set.
func scheduleLines(cfg *config.Config, at time.Time) []string {
	status := routing.Status(cfg.Routing.Schedule, at)
	if status == nil {
		return nil
	}
	active := "no window, so each routing uses its own models"
	if status.Active != "" {
		active = fmt.Sprintf("%s (%s)", status.ActiveLabel, status.Active)
	}
	line := fmt.Sprintf("schedule: %s, now %s", status.Timezone, active)
	if next, err := time.Parse(time.RFC3339, status.NextChange); err == nil {
		line += ", next change " + next.Format("Mon 15:04")
	}
	lines := []string{line}
	for _, window := range cfg.Routing.Schedule.Windows {
		lines = append(lines, fmt.Sprintf("  %s: %s %s-%s", window.ID, window.Label, window.Start, window.End))
	}
	return lines
}
