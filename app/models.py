from typing import List, Optional, Dict, Any
from pydantic import BaseModel, Field

class UserLogin(BaseModel):
    username: str
    password: str

class UserCreate(BaseModel):
    username: str
    password: str
    first_name: str
    last_name: str = ""
    title: str = ""
    role: Optional[str] = "staff"

class UserResponse(BaseModel):
    id: str
    username: str
    first_name: str
    last_name: str
    title: str
    role: str
    email: str = ""
    phone: str = ""

class UserContactUpdate(BaseModel):
    email: str = ""
    phone: str = ""

class UserPasswordReset(BaseModel):
    password: str
    confirm: str

class LoginResponse(BaseModel):
    token: str
    user: UserResponse

class NoteCreate(BaseModel):
    department: str
    priority: str = "normal"
    text: str
    photo_url: Optional[str] = None
    manager: Optional[str] = None
    time: Optional[str] = None
    status: str = "open"

class NoteUpdate(BaseModel):
    status: Optional[str] = None
    priority: Optional[str] = None
    text: Optional[str] = None

class NoteEvent(BaseModel):
    status: str
    at: str = ""
    actor: str = ""

class NoteResponse(BaseModel):
    id: str
    report_date: str
    department: str
    priority: str
    text: str
    photo_url: Optional[str] = None
    manager: str
    time: str
    status: str
    created_at: Optional[str] = None
    carried: bool = False
    timeline: list = []

class ChecklistItem(BaseModel):
    status: Optional[bool] = None
    comment: Optional[str] = ""
    photos: Optional[List[str]] = Field(default_factory=list)

class TrustYouData(BaseModel):
    totalReviews: Optional[str] = ""
    gss: Optional[str] = ""
    keyPositive: Optional[str] = ""
    keyNegative: Optional[str] = ""
    comment: Optional[str] = ""

class ReportSave(BaseModel):
    date: str
    status: Optional[str] = "draft"
    shiftStart: Optional[str] = ""
    shiftEnd: Optional[str] = ""
    occupancy: Optional[str] = ""
    arrivals: Optional[str] = ""
    departures: Optional[str] = ""
    inHouse: Optional[str] = ""
    allMembers: Optional[str] = ""
    cafeteriaMealTime: Optional[str] = ""
    cafeteriaTime: Optional[str] = ""
    checklists: Optional[Dict[str, List[ChecklistItem]]] = Field(default_factory=dict)
    cafeteriaItems: Optional[List[ChecklistItem]] = Field(default_factory=list)
    roomsInspection: Optional[List[Dict[str, Any]]] = Field(default_factory=list)
    courtesyCalls: Optional[List[Dict[str, Any]]] = Field(default_factory=list)
    trustYou: Optional[TrustYouData] = Field(default_factory=TrustYouData)
    complaints: Optional[List[Dict[str, Any]]] = Field(default_factory=list)
    incidents: Optional[List[Dict[str, Any]]] = Field(default_factory=list)
    generalComments: Optional[List[Dict[str, Any]]] = Field(default_factory=list)

class ReportIndexItem(BaseModel):
    date: str
    status: str
    submitted_at: Optional[str] = None
    submitted_by: Optional[str] = None
    occupancy: Optional[str] = ""
    manager_name: Optional[str] = ""
    notes_count: int = 0
    issues_count: int = 0
