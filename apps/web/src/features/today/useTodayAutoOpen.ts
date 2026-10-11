import { useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { useMe } from '../../api/hooks.ts';
import { useTodayShown } from './api.ts';

/*
 * Opens the Today window once per day when the person arrives at the map home page. A deep link
 * (any other first page) never asks, so opening a job from an email does not pop Today up over it.
 * Errors are ignored: Today is a nicety, and a failed ask must not disturb the page.
 */
export function useTodayAutoOpen(): void {
  const { pathname } = useLocation();
  // The page the person arrived on. Later navigation does not change it.
  const firstPath = useRef(pathname);
  // Guards React StrictMode's second run of the effect: the question is asked once
  const asked = useRef(false);
  const navigate = useNavigate();
  const me = useMe();
  const { mutate } = useTodayShown();

  useEffect(() => {
    if (me.data === undefined || asked.current || firstPath.current !== '/') return;
    asked.current = true;
    mutate(undefined, {
      onSuccess: ({ show }) => {
        if (show) void navigate('/today');
      },
    });
  }, [me.data, mutate, navigate]);
}
