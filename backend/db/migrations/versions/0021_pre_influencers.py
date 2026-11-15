"""pre_influencers for MJ Promoter Sugar Scratchie onboarding

Revision ID: 0021_pre_influencers
Revises: 0020_promoter_ref
Create Date: 2026-11-13

Invitees confirm email and name on the operator join page. Ordering a landing
page advances survey_step to 2 so MJ Promoter can show Make landing page done.
"""

from alembic import op

revision = "0021_pre_influencers"
down_revision = "0020_promoter_ref"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE pre_influencers (
            id UUID PRIMARY KEY,
            email CITEXT NOT NULL,
            full_name TEXT NOT NULL,
            invite_code TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending',
            survey_step INTEGER NOT NULL DEFAULT 0,
            mjfp_last_notified_step INTEGER,
            asset_link TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            CONSTRAINT pre_influencers_invite_code_uq UNIQUE (invite_code),
            CONSTRAINT pre_influencers_status_chk
                CHECK (status IN ('pending', 'confirmed', 'building')),
            CONSTRAINT pre_influencers_survey_step_chk
                CHECK (survey_step >= 0 AND survey_step <= 2)
        );
        CREATE INDEX pre_influencers_email_idx ON pre_influencers (email);
        """
    )


def downgrade() -> None:
    op.execute(
        """
        DROP INDEX IF EXISTS pre_influencers_email_idx;
        DROP TABLE IF EXISTS pre_influencers;
        """
    )
