From Coq Require Import String Ascii List.
From MetaCoq.Template Require Import All.
From MetaCoq.Common Require Import BasicAst Kernames Universes Environment.

Import MonadNotation.
Import ListNotations.
Local Open Scope string_scope.

Definition ivucx_quote_char : ascii := Ascii.ascii_of_nat 34.
Definition ivucx_backslash_char : ascii := Ascii.ascii_of_nat 92.
Definition ivucx_newline_char : ascii := Ascii.ascii_of_nat 10.
Definition ivucx_return_char : ascii := Ascii.ascii_of_nat 13.
Definition ivucx_tab_char : ascii := Ascii.ascii_of_nat 9.

Definition ivucx_char_string (ch : ascii) : string := String ch EmptyString.

Definition ivucx_quote_string : string := ivucx_char_string ivucx_quote_char.
Definition ivucx_backslash_string : string := ivucx_char_string ivucx_backslash_char.

Definition ivucx_json_null : string := "null".

Fixpoint ivucx_escape_json_string (value : string) : string :=
  match value with
  | EmptyString => EmptyString
  | String ch rest =>
      let escaped :=
        if Ascii.eqb ch ivucx_quote_char then ivucx_backslash_string ^ ivucx_quote_string
        else if Ascii.eqb ch ivucx_backslash_char then ivucx_backslash_string ^ ivucx_backslash_string
        else if Ascii.eqb ch ivucx_newline_char then ivucx_backslash_string ^ "n"
        else if Ascii.eqb ch ivucx_return_char then ivucx_backslash_string ^ "r"
        else if Ascii.eqb ch ivucx_tab_char then ivucx_backslash_string ^ "t"
        else ivucx_char_string ch
      in
      escaped ^ ivucx_escape_json_string rest
  end.

Definition ivucx_json_string (value : string) : string :=
  ivucx_quote_string ^ ivucx_escape_json_string value ^ ivucx_quote_string.

Definition ivucx_json_bool (value : bool) : string :=
  if value then "true" else "false".

Fixpoint ivucx_join_with_comma (items : list string) : string :=
  match items with
  | [] => EmptyString
  | [item] => item
  | item :: rest => item ^ "," ^ ivucx_join_with_comma rest
  end.

Definition ivucx_json_array (items : list string) : string :=
  "[" ^ ivucx_join_with_comma items ^ "]".

Definition ivucx_json_field (key value : string) : string :=
  ivucx_json_string key ^ ":" ^ value.

Definition ivucx_json_object (fields : list string) : string :=
  "{" ^ ivucx_join_with_comma fields ^ "}".

Definition ivucx_json_raw_level (value : string) : string :=
  ivucx_json_object [
    ivucx_json_field "kind" (ivucx_json_string "raw-level");
    ivucx_json_field "value" (ivucx_json_string value)
  ].

Definition ivucx_json_name (na : name) : string :=
  ivucx_json_string (string_of_name na).

Definition ivucx_json_aname (na : aname) : string :=
  ivucx_json_object [
    ivucx_json_field "name" (ivucx_json_string (string_of_name (binder_name na)));
    ivucx_json_field "relevance" (ivucx_json_string (string_of_relevance (binder_relevance na)))
  ].

Definition ivucx_json_aname_array (items : list aname) : string :=
  ivucx_json_array (map ivucx_json_aname items).

Definition ivucx_json_instance (u : Instance.t) : string :=
  ivucx_json_array (map (fun level => ivucx_json_raw_level (string_of_level level)) u).

Definition ivucx_json_sort (s : Sort.t) : string :=
  ivucx_json_object [
    ivucx_json_field "kind" (ivucx_json_string "sort");
    ivucx_json_field "level" (ivucx_json_raw_level (string_of_sort s))
  ].

Definition ivucx_json_cast_kind (kind : cast_kind) : string :=
  ivucx_json_string (
    match kind with
    | VmCast => "VmCast"
    | NativeCast => "NativeCast"
    | Cast => "Cast"
    end
  ).

Definition ivucx_json_projection (proj : projection) : string :=
  ivucx_json_object [
    ivucx_json_field "inductive" (ivucx_json_string (string_of_inductive (proj_ind proj)));
    ivucx_json_field "npars" (string_of_nat (proj_npars proj));
    ivucx_json_field "arg" (string_of_nat (proj_arg proj))
  ].

Fixpoint ivucx_json_term (t : term) : string
with ivucx_json_term_items (items : list term) : string
with ivucx_json_branch (b : branch term) : string
with ivucx_json_branch_items (items : list (branch term)) : string
with ivucx_json_def (d : def term) : string
with ivucx_json_def_items (items : list (def term)) : string :=
  match t with
  | tRel n =>
      ivucx_json_object [
        ivucx_json_field "kind" (ivucx_json_string "rel");
        ivucx_json_field "index" (string_of_nat n)
      ]
  | tVar id =>
      ivucx_json_object [
        ivucx_json_field "kind" (ivucx_json_string "var");
        ivucx_json_field "name" (ivucx_json_string id)
      ]
  | tEvar ev args =>
      ivucx_json_object [
        ivucx_json_field "kind" (ivucx_json_string "evar");
        ivucx_json_field "index" (string_of_nat ev);
        ivucx_json_field "args" ("[" ^ ivucx_json_term_items args ^ "]")
      ]
  | tSort s =>
      ivucx_json_sort s
  | tCast tm kind ty =>
      ivucx_json_object [
        ivucx_json_field "kind" (ivucx_json_string "cast");
        ivucx_json_field "castKind" (ivucx_json_cast_kind kind);
        ivucx_json_field "term" (ivucx_json_term tm);
        ivucx_json_field "type" (ivucx_json_term ty)
      ]
  | tProd na ty body =>
      ivucx_json_object [
        ivucx_json_field "kind" (ivucx_json_string "prod");
        ivucx_json_field "name" (ivucx_json_name (binder_name na));
        ivucx_json_field "binderInfo" (ivucx_json_string "default");
        ivucx_json_field "relevance" (ivucx_json_string (string_of_relevance (binder_relevance na)));
        ivucx_json_field "type" (ivucx_json_term ty);
        ivucx_json_field "body" (ivucx_json_term body)
      ]
  | tLambda na ty body =>
      ivucx_json_object [
        ivucx_json_field "kind" (ivucx_json_string "lambda");
        ivucx_json_field "name" (ivucx_json_name (binder_name na));
        ivucx_json_field "binderInfo" (ivucx_json_string "default");
        ivucx_json_field "relevance" (ivucx_json_string (string_of_relevance (binder_relevance na)));
        ivucx_json_field "type" (ivucx_json_term ty);
        ivucx_json_field "body" (ivucx_json_term body)
      ]
  | tLetIn na def def_ty body =>
      ivucx_json_object [
        ivucx_json_field "kind" (ivucx_json_string "let");
        ivucx_json_field "name" (ivucx_json_name (binder_name na));
        ivucx_json_field "relevance" (ivucx_json_string (string_of_relevance (binder_relevance na)));
        ivucx_json_field "type" (ivucx_json_term def_ty);
        ivucx_json_field "value" (ivucx_json_term def);
        ivucx_json_field "body" (ivucx_json_term body);
        ivucx_json_field "nondep" (ivucx_json_bool false)
      ]
  | tApp f args =>
      ivucx_json_object [
        ivucx_json_field "kind" (ivucx_json_string "app");
        ivucx_json_field "fn" (ivucx_json_term f);
        ivucx_json_field "args" ("[" ^ ivucx_json_term_items args ^ "]")
      ]
  | tConst c u =>
      ivucx_json_object [
        ivucx_json_field "kind" (ivucx_json_string "const");
        ivucx_json_field "name" (ivucx_json_string (string_of_kername c));
        ivucx_json_field "universes" (ivucx_json_instance u)
      ]
  | tInd ind u =>
      ivucx_json_object [
        ivucx_json_field "kind" (ivucx_json_string "ind");
        ivucx_json_field "name" (ivucx_json_string (string_of_inductive ind));
        ivucx_json_field "universes" (ivucx_json_instance u)
      ]
  | tConstruct ind idx u =>
      ivucx_json_object [
        ivucx_json_field "kind" (ivucx_json_string "construct");
        ivucx_json_field "inductive" (ivucx_json_string (string_of_inductive ind));
        ivucx_json_field "ctorIndex" (string_of_nat idx);
        ivucx_json_field "universes" (ivucx_json_instance u)
      ]
  | tCase ci type_info discr branches =>
      ivucx_json_object [
        ivucx_json_field "kind" (ivucx_json_string "case");
        ivucx_json_field "inductive" (ivucx_json_string (string_of_inductive (ci_ind ci)));
        ivucx_json_field "caseInfo" (
          ivucx_json_object [
            ivucx_json_field "npars" (string_of_nat (ci_npar ci));
            ivucx_json_field "relevance" (ivucx_json_string (string_of_relevance (ci_relevance ci)))
          ]
        );
        ivucx_json_field "predicate" (
          ivucx_json_object [
            ivucx_json_field "universes" (ivucx_json_instance (puinst type_info));
            ivucx_json_field "params" ("[" ^ ivucx_json_term_items (pparams type_info) ^ "]");
            ivucx_json_field "context" (ivucx_json_aname_array (pcontext type_info));
            ivucx_json_field "returnType" (ivucx_json_term (preturn type_info))
          ]
        );
        ivucx_json_field "discriminant" (ivucx_json_term discr);
        ivucx_json_field "branches" ("[" ^ ivucx_json_branch_items branches ^ "]")
      ]
  | tProj proj tm =>
      ivucx_json_object [
        ivucx_json_field "kind" (ivucx_json_string "proj");
        ivucx_json_field "typeName" (ivucx_json_string (string_of_inductive (proj_ind proj)));
        ivucx_json_field "index" (string_of_nat (proj_arg proj));
        ivucx_json_field "projection" (ivucx_json_projection proj);
        ivucx_json_field "struct" (ivucx_json_term tm)
      ]
  | tFix defs idx =>
      ivucx_json_object [
        ivucx_json_field "kind" (ivucx_json_string "fix");
        ivucx_json_field "index" (string_of_nat idx);
        ivucx_json_field "definitions" ("[" ^ ivucx_json_def_items defs ^ "]")
      ]
  | tCoFix defs idx =>
      ivucx_json_object [
        ivucx_json_field "kind" (ivucx_json_string "cofix");
        ivucx_json_field "index" (string_of_nat idx);
        ivucx_json_field "definitions" ("[" ^ ivucx_json_def_items defs ^ "]")
      ]
  | tInt _ =>
      ivucx_json_object [
        ivucx_json_field "kind" (ivucx_json_string "lit");
        ivucx_json_field "literal" (ivucx_json_string "int");
        ivucx_json_field "value" ivucx_json_null
      ]
  | tFloat _ =>
      ivucx_json_object [
        ivucx_json_field "kind" (ivucx_json_string "lit");
        ivucx_json_field "literal" (ivucx_json_string "float");
        ivucx_json_field "value" ivucx_json_null
      ]
  | tString _ =>
      ivucx_json_object [
        ivucx_json_field "kind" (ivucx_json_string "lit");
        ivucx_json_field "literal" (ivucx_json_string "string");
        ivucx_json_field "value" ivucx_json_null
      ]
  | tArray u items default_value item_type =>
      ivucx_json_object [
        ivucx_json_field "kind" (ivucx_json_string "array");
        ivucx_json_field "universe" (ivucx_json_raw_level (string_of_level u));
        ivucx_json_field "elements" ("[" ^ ivucx_json_term_items items ^ "]");
        ivucx_json_field "default" (ivucx_json_term default_value);
        ivucx_json_field "type" (ivucx_json_term item_type)
      ]
  end
with ivucx_json_term_items (items : list term) : string :=
  match items with
  | [] => EmptyString
  | [item] => ivucx_json_term item
  | item :: rest => ivucx_json_term item ^ "," ^ ivucx_json_term_items rest
  end
with ivucx_json_branch (b : branch term) : string :=
  ivucx_json_object [
    ivucx_json_field "names" (ivucx_json_aname_array (bcontext b));
    ivucx_json_field "body" (ivucx_json_term (bbody b))
  ]
with ivucx_json_branch_items (items : list (branch term)) : string :=
  match items with
  | [] => EmptyString
  | [item] => ivucx_json_branch item
  | item :: rest => ivucx_json_branch item ^ "," ^ ivucx_json_branch_items rest
  end
with ivucx_json_def (d : def term) : string :=
  ivucx_json_object [
    ivucx_json_field "name" (ivucx_json_name (binder_name (dname d)));
    ivucx_json_field "relevance" (ivucx_json_string (string_of_relevance (binder_relevance (dname d))));
    ivucx_json_field "type" (ivucx_json_term (dtype d));
    ivucx_json_field "body" (ivucx_json_term (dbody d));
    ivucx_json_field "recursiveArg" (string_of_nat (rarg d))
  ]
with ivucx_json_def_items (items : list (def term)) : string :=
  match items with
  | [] => EmptyString
  | [item] => ivucx_json_def item
  | item :: rest => ivucx_json_def item ^ "," ^ ivucx_json_def_items rest
  end.

Definition ivucx_json_constant_body (qualid_name : qualid) (body : constant_body) : string :=
  ivucx_json_object [
    ivucx_json_field "format" (ivucx_json_string "cic-v1");
    ivucx_json_field "theoremName" (ivucx_json_string qualid_name);
    ivucx_json_field "term" (
      match cst_body body with
      | Some term_body => ivucx_json_term term_body
      | None => ivucx_json_null
      end
    );
    ivucx_json_field "context" (
      ivucx_json_object [
        ivucx_json_field "type" (ivucx_json_term (cst_type body))
      ]
    );
    ivucx_json_field "declarations" ivucx_json_null;
    ivucx_json_field "metadata" (
      ivucx_json_object [
        ivucx_json_field "sourceLanguage" (ivucx_json_string "Coq");
        ivucx_json_field "extraction" (ivucx_json_string "metarocq-template");
        ivucx_json_field "relevance" (ivucx_json_string (string_of_relevance (cst_relevance body)));
        ivucx_json_field "hasBody" (ivucx_json_bool (
          match cst_body body with
          | Some _ => true
          | None => false
          end
        ));
        ivucx_json_field "universes" (
          match universes_entry_of_decl (cst_universes body) with
          | Monomorphic_entry => ivucx_json_string "monomorphic"
          | Polymorphic_entry _ => ivucx_json_string "polymorphic"
          end
        )
      ]
    )
  ].

Definition ivucx_export_constant (name : qualid) : TemplateMonad unit :=
  gr <- tmLocate1 name ;;
  match gr with
  | ConstRef kn =>
      body <- tmQuoteConstant kn true ;;
      tmMsg (ivucx_json_constant_body name body)
  | _ =>
      tmFail ("[" ^ name ^ "] is not a constant")
  end.

Redirect "__IVUCX_OUTPUT_PATH__" MetaRocq Run (ivucx_export_constant "__IVUCX_TARGET_QUALID__").
