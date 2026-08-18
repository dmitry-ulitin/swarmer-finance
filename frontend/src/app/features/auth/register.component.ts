import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { TuiButton, TuiIcon, TuiInput, TuiLink } from '@taiga-ui/core';
import { TuiPassword } from '@taiga-ui/kit';
import { AuthService } from '../../core/auth.service';
import { firstValueFrom } from 'rxjs/internal/firstValueFrom';
import { NotificationService } from '../../core/notification.service';

@Component({
  selector: 'app-register',
  imports: [ReactiveFormsModule, RouterLink, TuiButton, TuiIcon, TuiLink, TuiInput, TuiPassword],
  templateUrl: './register.component.html',
  styleUrl: './register.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RegisterComponent {
  private readonly authService = inject(AuthService);
  private readonly router = inject(Router);
  private readonly notifications = inject(NotificationService);

  form = new FormGroup({
    email: new FormControl('', [Validators.required, Validators.email]),
    password: new FormControl('', [Validators.required, Validators.minLength(6)]),
    name: new FormControl(''),
    currency: new FormControl('')
  });

  loading = signal(false);

  async onSubmit(event: Event) {
    event.preventDefault();
    if (this.form.invalid) {
      this.notifications.showError('Please fill in all required fields correctly');
      return;
    }

    this.loading.set(true);

    try {
      await firstValueFrom(this.authService.register(
        this.form.value.email!,
        this.form.value.password!,
        this.form.value.name!,
        this.form.value.currency!
      ));
      this.router.navigate(['/dashboard']);
    } catch (err) {
      this.loading.set(false);
      this.notifications.showError(err, 'Registration failed');
    }
  }
}
