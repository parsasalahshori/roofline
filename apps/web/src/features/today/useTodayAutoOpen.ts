import { useEffect, useLayoutEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { useMe } from '../../api/hooks.ts';
import { useTodayShown } from './api.ts';

/*
 * Opens the Today window once per day when the person arrives at the map home page. A deep link
 * (any other first page) never asks, so opening a job from an email does not pop Today up over it.
 * If the person leaves the map before the answer comes back (a dock click), Today does not open
 * over the page they chose. Errors are ignored: Today is a nicety, and a failed ask must not
 * disturb the page.
 */
export function useTodayAutoOpen(): void {
  const { pathname, search } = useLocation();
  // The page the person arrived on. Later navigation does not change it.
  const firstPath = useRef(new URLSearchParams(search).has('focus') ? null : pathname);
  // The current page, read when the answer arrives (the callback would otherwise see the old one)
  const pathnameRef = useRef(pathname);
  useLayoutEffect(() => {
    pathnameRef.current = new URLSearchParams(search).has('focus') ? '' : pathname;
  }, [pathname, search]);
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
        if (show && pathnameRef.current === '/') void navigate('/today');
      },
    });
  }, [me.data, mutate, navigate]);
}
