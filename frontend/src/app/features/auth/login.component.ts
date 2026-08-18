import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { TuiButton, TuiIcon, TuiInput, TuiLink } from '@taiga-ui/core';
import { AuthService } from '../../core/auth.service';
import { NotificationService } from '../../core/notification.service';
import { TuiPassword } from '@taiga-ui/kit';
import { firstValueFrom } from 'rxjs';

@Component({
  selector: 'app-login',
  imports: [ReactiveFormsModule, TuiLink, RouterLink, TuiButton, TuiInput, TuiPassword, TuiIcon],
  templateUrl: './login.component.html',
  styleUrl: './login.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LoginComponent {
  private readonly authService = inject(AuthService);
  private readonly router = inject(Router);
  private readonly notifications = inject(NotificationService);

  form = new FormGroup({
    email: new FormControl('', [Validators.required, Validators.email]),
    password: new FormControl('', [Validators.required])
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
      await firstValueFrom(this.authService.login(
        this.form.value.email!,
        this.form.value.password!
      ));
      this.router.navigate(['/dashboard']);
    } catch (err) {
      this.loading.set(false);
      this.notifications.showError(err, 'Login failed');
    }
  }
} 
