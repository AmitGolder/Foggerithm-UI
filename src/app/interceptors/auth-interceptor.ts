
import { HttpInterceptorFn } from '@angular/common/http';

export const authInterceptor: HttpInterceptorFn = (req, next) => {
  const token = localStorage.getItem('foggerithm_token');

  // Attach the token only to our own API requests.
  const isOurApi = req.url.startsWith('https://localhost:44361/api/');

  if (token && isOurApi) {
    req = req.clone({
      setHeaders: {
        Authorization: `Bearer ${token}`
      }
    });
  }

  return next(req);
};
