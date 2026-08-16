package ranking

import "errors"

// Sentinel errors. Every error returned by this package wraps one of them, so
// callers can branch with errors.Is without matching on message text.
var (
	// ErrInvalidConfig means the configuration itself is unusable: a negative
	// gravity, a grace window of zero, a non-finite weight.
	ErrInvalidConfig = errors.New("ranking: invalid config")

	// ErrFutureItem means an item is published after Now, which would give a
	// negative age and silently invert the ranking. Set Config.OnFutureItem to
	// ClampFuture to admit scheduled content as brand new instead.
	ErrFutureItem = errors.New("ranking: item is published in the future")

	// ErrMissingDate means an item has no publication date.
	ErrMissingDate = errors.New("ranking: item has no publication date")

	// ErrInvalidItem means an item carries a value the formula cannot use, such
	// as a NaN signal or an engagement sum below -1.
	ErrInvalidItem = errors.New("ranking: invalid item")

	// ErrUnsupported means the request cannot be expressed: an unknown preset or
	// SQL dialect, a custom engagement function asked to translate to SQL, or an
	// identifier that would have to be quoted.
	ErrUnsupported = errors.New("ranking: unsupported")
)
