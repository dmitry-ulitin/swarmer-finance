import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { type AbstractControl, FormControl, FormGroup, FormsModule, ReactiveFormsModule, type ValidationErrors, Validators } from '@angular/forms';
import { TuiButton, TuiDialogService, TuiInput, TuiLoader } from '@taiga-ui/core';
import type { TuiDialogContext } from '@taiga-ui/core';
import { TUI_CONFIRM, type TuiConfirmData, TuiChevron, TuiDataListWrapper, TuiSelect, TuiStringifyContentPipe } from '@taiga-ui/kit';
import { POLYMORPHEUS_CONTEXT } from '@taiga-ui/polymorpheus';
import { firstValueFrom, type Observable } from 'rxjs';
import { ApiService, type ApiResponse } from '../../../core/api.service';
import { AuthService } from '../../../core/auth.service';
import { AccountsState } from '../../../core/accounts.state';
import { CategoriesState } from '../../../core/categories.state';
import { TransactionsState } from '../../../core/transactions.state';
import { NotificationService } from '../../../core/notification.service';
import { LEVEL_LABELS, type Account, type AccountMember, type ShareChanges, type ShareLevel } from '../../../models/account';

const SHARE_LEVELS: readonly ShareLevel[] = [1, 2, 3];

/** Required and well-formed once trimmed, so a pasted address with stray spaces still passes. */
function trimmedEmail(control: AbstractControl<string>): ValidationErrors | null {
  const value = control.value.trim();
  return value ? Validators.email(new FormControl(value)) : { required: true };
}

@Component({
  selector: 'app-account-sharing',
  imports: [ReactiveFormsModule, FormsModule, TuiInput, TuiButton, TuiLoader, TuiChevron, TuiSelect, TuiDataListWrapper, TuiStringifyContentPipe],
  templateUrl: './account-sharing.html',
  styleUrl: './account-sharing.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AccountSharing {
  private readonly context = inject<TuiDialogContext<void, Account>>(POLYMORPHEUS_CONTEXT);
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);
  private readonly accountsState = inject(AccountsState);
  private readonly categoriesState = inject(CategoriesState);
  private readonly transactionsState = inject(TransactionsState);
  private readonly notifications = inject(NotificationService);
  private readonly dialogs = inject(TuiDialogService);

  private readonly account = this.context.data;

  readonly levels = SHARE_LEVELS;
  readonly levelLabel = (level: number): string => LEVEL_LABELS[level as ShareLevel];
  readonly busy = signal(false);
  readonly loading = signal(true);
  readonly members = signal<AccountMember[]>([]);
  readonly me = computed(() => this.members().find(m => m.user_id === this.auth.user()?.id) ?? null);
  readonly canManage = computed(() => (this.me()?.level ?? 0) >= 3);
  /** The Owner of a personal account cannot leave it, only delete it. */
  readonly canLeave = computed(() => {
    const me = this.me();
    return !!me && me.level !== 4;
  });

  /** Draft edits, sent together by Apply: changed levels, removed members, people to add. */
  readonly levelEdits = signal<ReadonlyMap<number, ShareLevel>>(new Map());
  readonly removed = signal<ReadonlySet<number>>(new Set());
  readonly added = signal<readonly { email: string; level: ShareLevel }[]>([]);
  readonly changes = computed<ShareChanges>(() => ({
    add: [...this.added()],
    update: [...this.levelEdits()].map(([userId, level]) => ({ userId, level })),
    remove: [...this.removed()],
  }));
  readonly dirty = computed(() => {
    const c = this.changes();
    return c.add.length + c.update.length + c.remove.length > 0;
  });

  readonly form = new FormGroup({
    email: new FormControl<string>('', { nonNullable: true, validators: [trimmedEmail] }),
    level: new FormControl<ShareLevel>(1, { nonNullable: true }),
  });

  constructor() {
    this.api.getAccountShares(this.account.id).subscribe({
      next: r => {
        this.members.set(r.data ?? []);
        this.loading.set(false);
      },
      error: e => {
        this.loading.set(false);
        this.notifications.showError(e, 'Failed to load sharing');
      },
    });
  }

  isMe(member: AccountMember): boolean {
    return member.user_id === this.me()?.user_id;
  }

  levelOf(member: AccountMember): number {
    return this.levelEdits().get(member.user_id) ?? member.level;
  }

  isChanged(member: AccountMember): boolean {
    return this.levelEdits().has(member.user_id);
  }

  isRemoved(member: AccountMember): boolean {
    return this.removed().has(member.user_id);
  }

  /** Puts a person into the draft; the server checks the email on Apply. */
  add(): void {
    if (this.form.invalid) return;
    const { email, level } = this.form.getRawValue();
    const trimmed = email.trim();
    const known = [...this.members().map(m => m.email), ...this.added().map(a => a.email)];
    if (known.some(e => e.toLowerCase() === trimmed.toLowerCase())) {
      this.notifications.showError(null, 'This user is already in the list');
      return;
    }
    this.added.update(list => [...list, { email: trimmed, level }]);
    this.form.reset();
  }

  setAddedLevel(index: number, level: ShareLevel): void {
    this.added.update(list => list.map((a, i) => (i === index ? { ...a, level } : a)));
  }

  dropAdded(index: number): void {
    this.added.update(list => list.filter((_, i) => i !== index));
  }

  /** Going back to the stored level drops the edit. */
  setLevel(member: AccountMember, level: ShareLevel): void {
    this.levelEdits.update(edits => {
      const next = new Map(edits);
      if (level === member.level) next.delete(member.user_id);
      else next.set(member.user_id, level);
      return next;
    });
  }

  /** Marks a member for removal, or takes the mark back; removal drops a level edit. */
  toggleRemove(member: AccountMember): void {
    const removing = !this.isRemoved(member);
    this.removed.update(set => {
      const next = new Set(set);
      if (removing) next.add(member.user_id);
      else next.delete(member.user_id);
      return next;
    });
    if (removing) {
      this.levelEdits.update(edits => {
        const next = new Map(edits);
        next.delete(member.user_id);
        return next;
      });
    }
  }

  cancel(): void {
    this.levelEdits.set(new Map());
    this.removed.set(new Set());
    this.added.set([]);
  }

  apply(): Promise<void> {
    return this.exclusive(async () => {
      if (!this.dirty()) return;
      const warnings = this.warnings();
      if (warnings.length && !await this.confirm('Apply changes', warnings.join(' '), 'Apply')) return;
      if (await this.mutate(this.api.applyAccountShares(this.account.id, this.changes()))) this.cancel();
    });
  }

  leave(): Promise<void> {
    return this.exclusive(async () => {
      const me = this.me();
      if (!me || !await this.confirm('Leave account', `Leave "${this.account.name}"? You will lose access to it.`, 'Leave')) return;
      if (await this.mutate(this.api.removeAccountShare(this.account.id, me.user_id))) this.context.completeWith();
    });
  }

  /** Runs one change at a time; the controls stay disabled while its confirm is open too. */
  private async exclusive(action: () => Promise<void>): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    try {
      await action();
    } finally {
      this.busy.set(false);
    }
  }

  /** What the draft gives up: sole or own ownership, the right to manage access, members' history. */
  private warnings(): string[] {
    const name = this.account.name;
    const me = this.me();
    const who = (m: AccountMember) => m.name || m.email;
    const warnings: string[] = [];

    // Granting co-owner on a personal account gives up sole ownership.
    if (me?.level === 4) {
      const coOwners = [
        ...this.members().filter(m => this.levelEdits().get(m.user_id) === 3).map(who),
        ...this.added().filter(a => a.level === 3).map(a => a.email),
      ];
      if (coOwners.length) {
        warnings.push(`"${name}" becomes co-owned: you will have equal rights with ${coOwners.join(', ')}.`);
      }
    }

    const ownLevel = me && this.levelEdits().get(me.user_id);
    if (me && ownLevel && ownLevel < 3) {
      const ownership = me.is_creator ? ' Ownership passes to another co-owner, and you' : ' You';
      warnings.push(
        `Lower your own level on "${name}" to ${LEVEL_LABELS[ownLevel]}?${ownership} will no longer be able to manage access.`,
      );
    }

    // Moving another creator below co-owner, or removing them, hands ownership to the caller.
    const creator = this.members().find(m => m.is_creator);
    if (creator && !this.isMe(creator) && (this.levelEdits().has(creator.user_id) || this.isRemoved(creator))) {
      warnings.push(`${who(creator)} created "${name}". Changing their level or removing them makes you the owner.`);
    }

    const leaving = this.members().filter(m => this.isRemoved(m)).map(who);
    if (leaving.length) {
      warnings.push(`Remove ${leaving.join(', ')} from "${name}"? Their income and expenses on this account pass to the owner.`);
    }
    return warnings;
  }

  private confirm(label: string, content: string, yes: string): Promise<boolean> {
    const data: TuiConfirmData = { content, yes, no: 'Cancel' };
    return firstValueFrom(this.dialogs.open<boolean>(TUI_CONFIRM, { label, size: 's', data }), { defaultValue: false });
  }

  private async mutate(request: Observable<ApiResponse<AccountMember[]>>): Promise<boolean> {
    try {
      const r = await firstValueFrom(request);
      const members = r.data ?? [];
      this.members.set(members);
      this.accountsState.reload();
      this.categoriesState.reload();
      // A filter still naming an account the user just left would show nothing.
      if (members.some(m => m.user_id === this.auth.user()?.id)) this.transactionsState.reload();
      else this.transactionsState.reloadWithout(this.account.id);
      return true;
    } catch (e) {
      this.notifications.showError(e, 'Failed to update sharing');
      return false;
    }
  }
}
