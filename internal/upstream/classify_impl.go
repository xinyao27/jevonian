package upstream

import (
	"context"
	"errors"
	"regexp"
)

// reContextOverflow matches the wording providers use for a too-long request.
// src/upstream.ts isContextOverflowResponse.
func reContextOverflow() *regexp.Regexp {
	return regexp.MustCompile(`(?i)context_length_exceeded|context window|prompt is too long|maximum context length|too many (input )?tokens|input is too long|input tokens exceed|input_too_large`)
}

// isContextCancel distinguishes a caller hang-up (free the slot, don't judge
// the host) from a host-side failure.
func isContextCancelErr(err error) bool {
	return errors.Is(err, context.Canceled)
}
