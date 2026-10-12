"""Unit constants and the convective-day rule shared by the hail service."""

from datetime import date, datetime, timedelta, timezone

MM_PER_IN = 25.4
HAIL_LEVELS_IN = (0.75, 1.0, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0)


def convective_day(t: datetime) -> date:
    """Convective day runs 12Z to 12Z; instants before 12:00Z belong to the previous day."""
    t = t.replace(tzinfo=timezone.utc) if t.tzinfo is None else t.astimezone(timezone.utc)
    if t.hour < 12:
        return (t - timedelta(days=1)).date()
    return t.date()


def final_instant(day: date) -> datetime:
    """The instant that closes convective day `day`: the next day at 12:00:00Z."""
    return datetime(day.year, day.month, day.day, 12, 0, 0, tzinfo=timezone.utc) + timedelta(days=1)
