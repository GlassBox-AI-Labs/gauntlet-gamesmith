export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      games: {
        Row: {
          created_at: string
          current_release_id: string | null
          generation: number
          id: string
          publisher_id: string
          slug: string
        }
        Insert: {
          created_at?: string
          current_release_id?: string | null
          generation?: number
          id: string
          publisher_id: string
          slug: string
        }
        Update: {
          created_at?: string
          current_release_id?: string | null
          generation?: number
          id?: string
          publisher_id?: string
          slug?: string
        }
        Relationships: [
          {
            foreignKeyName: "current_release_belongs_to_game"
            columns: ["id", "current_release_id"]
            isOneToOne: false
            referencedRelation: "releases"
            referencedColumns: ["game_id", "id"]
          },
          {
            foreignKeyName: "games_publisher_id_fkey"
            columns: ["publisher_id"]
            isOneToOne: false
            referencedRelation: "publishers"
            referencedColumns: ["id"]
          },
        ]
      }
      publication_events: {
        Row: {
          created_at: string
          game_id: string
          id: number
          kind: string
          release_id: string | null
        }
        Insert: {
          created_at?: string
          game_id: string
          id?: never
          kind: string
          release_id?: string | null
        }
        Update: {
          created_at?: string
          game_id?: string
          id?: never
          kind?: string
          release_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "publication_events_game_id_fkey"
            columns: ["game_id"]
            isOneToOne: false
            referencedRelation: "games"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "publication_events_release_id_fkey"
            columns: ["release_id"]
            isOneToOne: false
            referencedRelation: "releases"
            referencedColumns: ["id"]
          },
        ]
      }
      publishers: {
        Row: {
          display_name: string
          email_domain_access: boolean
          enabled: boolean
          handle: string
          id: string
        }
        Insert: {
          display_name: string
          email_domain_access?: boolean
          enabled?: boolean
          handle: string
          id: string
        }
        Update: {
          display_name?: string
          email_domain_access?: boolean
          enabled?: boolean
          handle?: string
          id?: string
        }
        Relationships: []
      }
      releases: {
        Row: {
          base_generation: number
          created_at: string
          digest: string
          error: string | null
          game_id: string
          id: string
          listing: Json
          request_key: string
          source: Json | null
          status: string
        }
        Insert: {
          base_generation: number
          created_at?: string
          digest: string
          error?: string | null
          game_id: string
          id: string
          listing: Json
          request_key: string
          source?: Json | null
          status?: string
        }
        Update: {
          base_generation?: number
          created_at?: string
          digest?: string
          error?: string | null
          game_id?: string
          id?: string
          listing?: Json
          request_key?: string
          source?: Json | null
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "releases_game_id_fkey"
            columns: ["game_id"]
            isOneToOne: false
            referencedRelation: "games"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      begin_release: {
        Args: {
          actor: string
          artifact_digest: string
          metadata: Json
          provenance: Json
          retry_key: string
          target_game: string
        }
        Returns: {
          base_generation: number
          created_at: string
          digest: string
          error: string | null
          game_id: string
          id: string
          listing: Json
          request_key: string
          source: Json | null
          status: string
        }
        SetofOptions: {
          from: "*"
          to: "releases"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      catalog_games: { Args: never; Returns: Json }
      promote_game: {
        Args: {
          actor: string
          expected_generation: number
          target_game: string
          target_release: string
        }
        Returns: {
          created_at: string
          current_release_id: string | null
          generation: number
          id: string
          publisher_id: string
          slug: string
        }
        SetofOptions: {
          from: "*"
          to: "games"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      publisher_for_user: { Args: { actor: string }; Returns: Json }
      publisher_studio: { Args: { actor: string }; Returns: Json }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {},
  },
} as const
