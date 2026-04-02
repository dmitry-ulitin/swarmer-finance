import { Component, inject, INJECTOR } from '@angular/core';
import { AuthService } from '../../core/auth.service';
import { TuiButton, tuiDialog } from '@taiga-ui/core';

@Component({
  selector: 'app-header',
  imports: [TuiButton],
  templateUrl: './header.html',
  styleUrl: './header.scss',
})
export class Header {
  authService = inject(AuthService);
  private readonly injector = inject(INJECTOR);

  async categories() {
    const {Categories} = await import('../categories/categories');
    tuiDialog(Categories, {
      injector: this.injector,
      label: 'Categories',
      size: 'l',
    })().subscribe();
  }

  async accounts() {
    const {Accounts} = await import('../accounts/accounts');
    tuiDialog(Accounts, {
      injector: this.injector,
      label: 'Accounts',
      size: 'm',
    })().subscribe();
  }
}
